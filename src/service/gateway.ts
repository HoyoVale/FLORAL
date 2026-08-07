import type {
  AgentRuntime,
  ChatTransport,
  GatewayStore,
} from "../core/contracts.js";
import type {
  AgentEvent,
  IncomingMessage,
  ResolvedGatewayIdentity,
} from "../core/types.js";
import {
  PairingAttemptLimiter,
  pairingCodeMatches,
  parseGatewayCommand,
  type GatewayCommand,
} from "./gateway-commands.js";

export interface GatewayOptions {
  cwd: string;
  model?: string;
  ownerPairingCode?: string;
  trustMockOwner?: boolean;
  runtimeStatusLines?: (() => Promise<string[]>) | undefined;
}

interface ActiveRun {
  threadId?: string;
  stopRequested: boolean;
  interruptSent: boolean;
}

export class GatewayService {
  readonly #activeRuns = new Map<string, ActiveRun>();
  readonly #pairingLimiter = new PairingAttemptLimiter();
  #started = false;
  #stopped = false;

  constructor(
    private readonly transport: ChatTransport,
    private readonly agent: AgentRuntime,
    private readonly store: GatewayStore,
    private readonly options: GatewayOptions,
  ) {}

  async start(): Promise<void> {
    if (this.#started) return;
    if (this.#stopped) throw new Error("Gateway service cannot be restarted after stop");

    try {
      await this.agent.start();
      await this.transport.start((message) => this.#handle(message));
      this.#started = true;
    } catch (error) {
      await Promise.allSettled([
        this.transport.stop(),
        this.agent.stop(),
        this.store.close(),
      ]);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    await Promise.allSettled([this.transport.stop(), this.agent.stop()]);
    this.#activeRuns.clear();
    await this.store.close();
  }

  async #handle(message: IncomingMessage): Promise<void> {
    if (!message.text.trim()) return;

    const accepted = await this.store.acceptMessage(
      message.identity,
      message.id,
      message.receivedAt,
    );
    if (!accepted) return;

    if (message.text.length > 32_000) {
      await this.store.appendAudit({
        eventType: "input.rejected_too_large",
        payload: {
          transport: message.identity.transport,
          characterCount: message.text.length,
        },
      });
      await this.#send(
        message.identity.conversationId,
        "消息过长，已拒绝执行。",
      );
      return;
    }

    let resolved = await this.store.resolveIdentity(message.identity);
    const command = parseGatewayCommand(message.text);

    if (!resolved && message.identity.transport === "mock" && this.options.trustMockOwner) {
      resolved = await this.store.claimOwner(message.identity);
      await this.store.appendAudit({
        userId: resolved.userId,
        conversationId: resolved.conversationId,
        eventType: "identity.trusted_local_owner",
        payload: { transport: "mock" },
      });
    }

    if (!resolved) {
      if (command?.type === "pair") {
        await this.#handlePairing(message, command);
      } else {
        await this.store.appendAudit({
          eventType: "authorization.denied",
          payload: {
            transport: message.identity.transport,
            command: command?.type ?? "message",
          },
        });
        await this.#send(
          message.identity.conversationId,
          "此 QQ 身份尚未绑定。请使用 /pair <配对码> 完成所有者绑定。",
        );
      }
      return;
    }

    if (command) {
      await this.#handleCommand(message, resolved, command);
      return;
    }

    await this.#runAgent(message, resolved);
  }

  async #handlePairing(
    message: IncomingMessage,
    command: Extract<GatewayCommand, { type: "pair" }>,
  ): Promise<void> {
    const attemptKey = [
      message.identity.transport,
      message.identity.botId,
      message.identity.externalUserId,
    ].join("\u0000");

    if (!this.#pairingLimiter.canAttempt(attemptKey)) {
      await this.store.appendAudit({
        eventType: "identity.pairing_rate_limited",
        payload: { transport: message.identity.transport },
      });
      await this.#send(
        message.identity.conversationId,
        "配对尝试过于频繁，请稍后再试。",
      );
      return;
    }

    if (!this.options.ownerPairingCode) {
      await this.#send(
        message.identity.conversationId,
        "所有者配对尚未在服务器上启用。",
      );
      return;
    }

    if (await this.store.hasOwner(message.identity.transport, message.identity.botId)) {
      await this.#send(
        message.identity.conversationId,
        "该机器人已完成所有者绑定。",
      );
      return;
    }

    if (!pairingCodeMatches(command.code, this.options.ownerPairingCode)) {
      this.#pairingLimiter.recordFailure(attemptKey);
      await this.store.appendAudit({
        eventType: "identity.pairing_failed",
        payload: { transport: message.identity.transport },
      });
      await this.#send(
        message.identity.conversationId,
        command.code
          ? "配对失败。"
          : "用法：/pair <配对码>",
      );
      return;
    }

    try {
      const resolved = await this.store.claimOwner(message.identity);
      this.#pairingLimiter.recordSuccess(attemptKey);
      await this.store.appendAudit({
        userId: resolved.userId,
        conversationId: resolved.conversationId,
        eventType: "identity.owner_paired",
        payload: { transport: message.identity.transport },
      });
      await this.#send(
        message.identity.conversationId,
        "所有者绑定成功。现在可以发送消息，或使用 /status 查看状态。",
      );
    } catch {
      await this.store.appendAudit({
        eventType: "identity.pairing_conflict",
        payload: { transport: message.identity.transport },
      });
      await this.#send(
        message.identity.conversationId,
        "该机器人已完成所有者绑定。",
      );
    }
  }

  async #handleCommand(
    message: IncomingMessage,
    resolved: ResolvedGatewayIdentity,
    command: GatewayCommand,
  ): Promise<void> {
    switch (command.type) {
      case "pair":
        await this.#send(
          message.identity.conversationId,
          "当前身份已经完成绑定。",
        );
        return;

      case "status": {
        const threadId = await this.store.getActiveThread(resolved.conversationId);
        const active = this.#activeRuns.has(resolved.conversationId);
        await this.store.appendAudit({
          userId: resolved.userId,
          conversationId: resolved.conversationId,
          eventType: "command.status",
        });
        const runtimeLines = this.options.runtimeStatusLines
          ? await this.options.runtimeStatusLines().catch(() => ["cost_guard=error"])
          : [];
        await this.#send(
          message.identity.conversationId,
          [
            "FLORAL 状态",
            `transport=${this.transport.name}`,
            `agent=${this.agent.name}`,
            `role=${resolved.role}`,
            `thread=${threadId ? "active" : "none"}`,
            `run=${active ? "active" : "idle"}`,
            ...runtimeLines,
          ].join("\n"),
        );
        return;
      }

      case "new":
        if (this.#activeRuns.has(resolved.conversationId)) {
          await this.#send(
            message.identity.conversationId,
            "当前仍有任务运行，请先使用 /stop。",
          );
          return;
        }
        await this.store.clearActiveThread(resolved.conversationId);
        await this.store.appendAudit({
          userId: resolved.userId,
          conversationId: resolved.conversationId,
          eventType: "command.new",
        });
        await this.#send(
          message.identity.conversationId,
          "已创建新的会话上下文；下一条消息会启动新的 Codex thread。",
        );
        return;

      case "stop": {
        const active = this.#activeRuns.get(resolved.conversationId);
        if (!active) {
          await this.#send(
            message.identity.conversationId,
            "当前没有正在运行的任务。",
          );
          return;
        }

        active.stopRequested = true;
        if (active.threadId && !active.interruptSent) {
          await this.#interruptRun(resolved, active);
        }
        await this.store.appendAudit({
          userId: resolved.userId,
          conversationId: resolved.conversationId,
          eventType: "command.stop",
          payload: { interruptDispatched: active.interruptSent },
        });
        await this.#send(
          message.identity.conversationId,
          active.interruptSent
            ? "已向当前任务发送停止请求。"
            : "停止请求已记录，任务线程建立后会立即中断。",
        );
        return;
      }
    }
  }

  async #runAgent(
    message: IncomingMessage,
    resolved: ResolvedGatewayIdentity,
  ): Promise<void> {
    if (this.#activeRuns.has(resolved.conversationId)) {
      await this.#send(
        message.identity.conversationId,
        "当前会话已有任务运行。使用 /status 查看状态，或使用 /stop 中断。",
      );
      return;
    }

    const active: ActiveRun = {
      stopRequested: false,
      interruptSent: false,
    };
    this.#activeRuns.set(resolved.conversationId, active);

    await this.store.appendAudit({
      userId: resolved.userId,
      conversationId: resolved.conversationId,
      eventType: "agent.run_requested",
      payload: { characterCount: message.text.length },
    });

    try {
      const threadId = await this.store.getActiveThread(resolved.conversationId);
      const result = await this.agent.run(
        {
          ...(threadId ? { threadId } : {}),
          text: message.text,
          cwd: this.options.cwd,
          ...(this.options.model ? { model: this.options.model } : {}),
        },
        (event) => this.#handleAgentEvent(resolved, active, event),
      );

      await this.store.setActiveThread(resolved.conversationId, result.threadId);
      await this.store.appendAudit({
        userId: resolved.userId,
        conversationId: resolved.conversationId,
        eventType: "agent.run_completed",
        payload: { responseCharacterCount: result.finalText.length },
      });
      await this.#deliverWithAudit(
        message.identity.conversationId,
        result.finalText,
        resolved,
        "agent_reply",
      );
    } catch (error) {
      await this.store.appendAudit({
        userId: resolved.userId,
        conversationId: resolved.conversationId,
        eventType: "agent.run_failed",
        payload: {
          errorType: error instanceof Error ? error.name : "unknown",
          stopRequested: active.stopRequested,
        },
      });
      await this.#deliverWithAudit(
        message.identity.conversationId,
        active.stopRequested
          ? "当前任务已停止。"
          : "任务执行失败，请在 Mac 本地查看服务日志。",
        resolved,
        "agent_failure",
      );
    } finally {
      if (this.#activeRuns.get(resolved.conversationId) === active) {
        this.#activeRuns.delete(resolved.conversationId);
      }
    }
  }

  #handleAgentEvent(
    resolved: ResolvedGatewayIdentity,
    active: ActiveRun,
    event: AgentEvent,
  ): void {
    if (event.type === "run.started") {
      active.threadId = event.threadId;
      if (active.stopRequested && !active.interruptSent) {
        void this.#interruptRun(resolved, active).catch(() => undefined);
      }
      return;
    }

    if (event.type === "tool.started" || event.type === "tool.completed") {
      void this.store.appendAudit({
        userId: resolved.userId,
        conversationId: resolved.conversationId,
        eventType: `agent.${event.type}`,
        payload: { tool: event.name },
      }).catch(() => undefined);
      return;
    }

    if (event.type === "approval.requested") {
      void this.store.appendAudit({
        userId: resolved.userId,
        conversationId: resolved.conversationId,
        eventType: "agent.approval_declined",
      }).catch(() => undefined);
    }
  }

  async #interruptRun(
    resolved: ResolvedGatewayIdentity,
    active: ActiveRun,
  ): Promise<void> {
    const threadId = active.threadId;
    if (!threadId || active.interruptSent) return;
    active.interruptSent = true;
    try {
      await this.agent.interrupt(threadId);
      await this.store.appendAudit({
        userId: resolved.userId,
        conversationId: resolved.conversationId,
        eventType: "agent.interrupt_sent",
      });
    } catch (error) {
      await this.store.appendAudit({
        userId: resolved.userId,
        conversationId: resolved.conversationId,
        eventType: "agent.interrupt_failed",
        payload: {
          errorType: error instanceof Error ? error.name : "unknown",
        },
      });
    }
  }

  async #deliverWithAudit(
    conversationId: string,
    text: string,
    resolved: ResolvedGatewayIdentity,
    kind: "agent_reply" | "agent_failure",
  ): Promise<void> {
    try {
      await this.#send(conversationId, text);
    } catch (error) {
      await this.store.appendAudit({
        userId: resolved.userId,
        conversationId: resolved.conversationId,
        eventType: "transport.delivery_failed",
        payload: {
          transport: this.transport.name,
          kind,
          errorType: error instanceof Error ? error.name : "unknown",
        },
      });
    }
  }

  async #send(conversationId: string, text: string): Promise<void> {
    await this.transport.send({ conversationId, text });
  }
}
