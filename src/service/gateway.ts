import {
  supportsConversationActivity,
  supportsInteractiveApproval,
  supportsMediaTransport,
  type AgentRuntime,
  type ChatTransport,
  type ConversationActivityState,
  type GatewayStore,
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
import type { AuthorizationAuthority } from "../policy/authorization-authority.js";
import { QqApprovalBroker } from "../policy/qq-approval-broker.js";
import type { LocalConfirmationBroker } from "../policy/local-confirmation-broker.js";
import type {
  ArtifactEgressPolicy,
  ArtifactEgressRunBudget,
} from "../policy/artifact-egress-policy.js";
import { formatGatewayStatus, gatewayHelpText } from "./gateway-status.js";

export interface GatewayOptions {
  cwd: string;
  model?: string;
  ownerPairingCode?: string;
  trustMockOwner?: boolean;
  runtimeStatusLines?: (() => Promise<string[]>) | undefined;
  conversationUx?: {
    visibleActivityFallback: boolean;
    visibleActivityDelayMs: number;
  } | undefined;
  authorization?: {
    authority: AuthorizationAuthority;
    approvalTtlMs: number;
    maxPendingApprovals: number;
    ownerOnlyRemoteApproval: boolean;
    localConfirmation?: LocalConfirmationBroker | undefined;
  } | undefined;
  artifactEgress?: {
    policy: ArtifactEgressPolicy;
  } | undefined;
}

interface ActiveRun {
  threadId?: string;
  stopRequested: boolean;
  interruptSent: boolean;
  visibleActivityTimer?: ReturnType<typeof setTimeout> | undefined;
  visibleActivitySatisfied: boolean;
  waitingForApproval: boolean;
  latestToolName?: string | undefined;
  artifactEgressTail: Promise<void>;
  artifactBudget?: ArtifactEgressRunBudget | undefined;
}

export class GatewayService {
  readonly #activeRuns = new Map<string, ActiveRun>();
  readonly #pairingLimiter = new PairingAttemptLimiter();
  readonly #approvalBroker: QqApprovalBroker | undefined;
  #started = false;
  #stopped = false;

  constructor(
    private readonly transport: ChatTransport,
    private readonly agent: AgentRuntime,
    private readonly store: GatewayStore,
    private readonly options: GatewayOptions,
  ) {
    const authorization = options.authorization;
    const interactiveTransport = supportsInteractiveApproval(this.transport)
      ? this.transport
      : undefined;
    this.#approvalBroker = authorization
      ? new QqApprovalBroker({
          ttlMs: authorization.approvalTtlMs,
          maxPending: authorization.maxPendingApprovals,
          ownerOnly: authorization.ownerOnlyRemoteApproval,
          authority: authorization.authority,
          localConfirmation: authorization.localConfirmation,
          send: (conversationId, text) => this.#send(conversationId, text),
          ...(interactiveTransport ? {
            sendInteractive: (prompt) =>
              interactiveTransport.sendInteractiveApprovalPrompt(prompt),
          } : {}),
          audit: (event) => this.store.appendAudit(event),
        })
      : undefined;
  }

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
    this.#approvalBroker?.cancelAll();
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
          "当前聊天身份尚未绑定。请使用 /pair <配对码> 完成所有者绑定。",
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
          payload: { debug: command.debug },
        });
        const runtimeLines = this.options.runtimeStatusLines
          ? await this.options.runtimeStatusLines().catch(() => ["cost_guard=error"])
          : [];
        await this.#send(
          message.identity.conversationId,
          formatGatewayStatus({
            transport: this.transport.name,
            agent: this.agent.name,
            role: resolved.role,
            threadActive: Boolean(threadId),
            runActive: active,
            pendingApprovals: this.#approvalBroker?.pendingCount(resolved.conversationId) ?? 0,
            runtimeLines,
          }, command.debug),
        );
        return;
      }

      case "help":
        await this.store.appendAudit({
          userId: resolved.userId,
          conversationId: resolved.conversationId,
          eventType: "command.help",
        });
        await this.#send(message.identity.conversationId, gatewayHelpText());
        return;

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
          "新会话已建立。下一条消息会从新的上下文开始。",
        );
        return;

      case "approve":
      case "deny": {
        if (!command.approvalId) {
          await this.#send(
            message.identity.conversationId,
            `用法：/${command.type} <审批编号>`,
          );
          return;
        }
        if (!this.#approvalBroker) {
          await this.#send(message.identity.conversationId, "远程审批功能未启用。");
          return;
        }
        const outcome = await this.#approvalBroker.resolve(
          {
            userId: resolved.userId,
            role: resolved.role,
            conversationId: resolved.conversationId,
          },
          command.approvalId,
          command.type === "approve" ? "approve" : "deny",
        );
        await this.store.appendAudit({
          userId: resolved.userId,
          conversationId: resolved.conversationId,
          eventType: `command.${command.type}`,
          payload: { outcome },
        });
        await this.#send(
          message.identity.conversationId,
          approvalCommandReply(command.type, outcome),
        );
        return;
      }

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
        this.#cancelVisibleActivityFallback(active);
        this.#setConversationActivity(message.identity.conversationId, "idle");
        this.#approvalBroker?.cancelConversation(resolved.conversationId);
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
        "正在处理上一条消息。使用 /status 查看状态，或使用 /stop 停止。",
      );
      return;
    }

    const active: ActiveRun = {
      stopRequested: false,
      interruptSent: false,
      visibleActivitySatisfied: false,
      waitingForApproval: false,
      artifactEgressTail: Promise.resolve(),
      ...(this.options.artifactEgress
        ? { artifactBudget: this.options.artifactEgress.policy.createRunBudget() }
        : {}),
    };
    this.#activeRuns.set(resolved.conversationId, active);

    await this.store.appendAudit({
      userId: resolved.userId,
      conversationId: resolved.conversationId,
      eventType: "agent.run_requested",
      payload: { characterCount: message.text.length },
    });
    this.#setConversationActivity(message.identity.conversationId, "typing");
    this.#scheduleVisibleActivityFallback(
      message.identity.conversationId,
      resolved,
      active,
    );

    try {
      const threadId = await this.store.getActiveThread(resolved.conversationId);
      const result = await this.agent.run(
        {
          ...(threadId ? { threadId } : {}),
          text: message.text,
          cwd: this.options.cwd,
          ...(this.options.model ? { model: this.options.model } : {}),
          ...(this.#approvalBroker ? {
            approvalHandler: async (request) => {
              active.waitingForApproval = true;
              active.visibleActivitySatisfied = true;
              this.#cancelVisibleActivityFallback(active);
              this.#setConversationActivity(
                message.identity.conversationId,
                "idle",
              );
              const decision = await this.#approvalBroker!.request(
                {
                  userId: resolved.userId,
                  role: resolved.role,
                  conversationId: resolved.conversationId,
                  deliveryConversationId: message.identity.conversationId,
                },
                request,
              );
              active.waitingForApproval = false;
              if (
                !active.stopRequested
                && this.#activeRuns.get(resolved.conversationId) === active
              ) {
                this.#setConversationActivity(
                  message.identity.conversationId,
                  "typing",
                );
              }
              return decision;
            },
          } : {}),
        },
        (event) => this.#handleAgentEvent(
          message.identity.conversationId,
          resolved,
          active,
          event,
        ),
      );

      await active.artifactEgressTail.catch(() => undefined);
      await this.store.setActiveThread(resolved.conversationId, result.threadId);
      await this.store.appendAudit({
        userId: resolved.userId,
        conversationId: resolved.conversationId,
        eventType: "agent.run_completed",
        payload: { responseCharacterCount: result.finalText.length },
      });
      this.#cancelVisibleActivityFallback(active);
      this.#setConversationActivity(message.identity.conversationId, "idle");
      await this.#deliverWithAudit(
        message.identity.conversationId,
        result.finalText,
        resolved,
        "agent_reply",
      );
    } catch (error) {
      this.#cancelVisibleActivityFallback(active);
      this.#setConversationActivity(message.identity.conversationId, "idle");
      process.stderr.write(`${formatSafeAgentFailure(error)}\n`);
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
      this.#cancelVisibleActivityFallback(active);
      this.#approvalBroker?.cancelConversation(resolved.conversationId);
      if (this.#activeRuns.get(resolved.conversationId) === active) {
        this.#activeRuns.delete(resolved.conversationId);
      }
    }
  }

  #handleAgentEvent(
    deliveryConversationId: string,
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
      if (event.type === "tool.started") active.latestToolName = event.name;
      void this.store.appendAudit({
        userId: resolved.userId,
        conversationId: resolved.conversationId,
        eventType: `agent.${event.type}`,
        payload: { tool: event.name },
      }).catch(() => undefined);
      return;
    }

    if (event.type === "artifact.available") {
      active.artifactEgressTail = active.artifactEgressTail
        .catch(() => undefined)
        .then(() => this.#deliverArtifact(
          deliveryConversationId,
          resolved,
          active,
          event.artifact,
        ));
      return;
    }

    if (event.type === "approval.requested") {
      void this.store.appendAudit({
        userId: resolved.userId,
        conversationId: resolved.conversationId,
        eventType: "agent.approval_requested",
        payload: { capability: event.capability, kind: event.kind },
      }).catch(() => undefined);
    }
  }

  #scheduleVisibleActivityFallback(
    deliveryConversationId: string,
    resolved: ResolvedGatewayIdentity,
    active: ActiveRun,
  ): void {
    const ux = this.options.conversationUx;
    if (!ux?.visibleActivityFallback || active.visibleActivitySatisfied) return;
    this.#cancelVisibleActivityFallback(active);

    const timer = setTimeout(() => {
      active.visibleActivityTimer = undefined;
      if (
        active.stopRequested
        || active.waitingForApproval
        || active.visibleActivitySatisfied
        || this.#activeRuns.get(resolved.conversationId) !== active
      ) {
        return;
      }

      active.visibleActivitySatisfied = true;
      const progress = visibleActivityProgress(active.latestToolName);
      void (async () => {
        try {
          await this.#send(deliveryConversationId, progress.text);
          await this.store.appendAudit({
            userId: resolved.userId,
            conversationId: resolved.conversationId,
            eventType: "conversation.visible_activity_sent",
            payload: { category: progress.category },
          }).catch(() => undefined);
        } catch (error) {
          process.stderr.write(
            `conversation.visible_activity_error=${safeLogToken(
              error instanceof Error ? error.name : "Error",
            )}\n`,
          );
          await this.store.appendAudit({
            userId: resolved.userId,
            conversationId: resolved.conversationId,
            eventType: "conversation.visible_activity_failed",
            payload: {
              category: progress.category,
              errorType: error instanceof Error ? error.name : "unknown",
            },
          }).catch(() => undefined);
        }
      })();
    }, ux.visibleActivityDelayMs);
    timer.unref?.();
    active.visibleActivityTimer = timer;
  }

  #cancelVisibleActivityFallback(active: ActiveRun): void {
    if (!active.visibleActivityTimer) return;
    clearTimeout(active.visibleActivityTimer);
    active.visibleActivityTimer = undefined;
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

  async #deliverArtifact(
    deliveryConversationId: string,
    resolved: ResolvedGatewayIdentity,
    active: ActiveRun,
    artifact: Extract<AgentEvent, { type: "artifact.available" }>["artifact"],
  ): Promise<void> {
    const egress = this.options.artifactEgress;
    const budget = active.artifactBudget;
    if (!egress || !budget) {
      await this.#auditArtifactEgress(
        resolved,
        artifact,
        "denied",
        "policy-disabled",
      );
      return;
    }
    const mediaTransport = supportsMediaTransport(this.transport)
      ? this.transport
      : undefined;
    if (!mediaTransport) {
      await this.#auditArtifactEgress(
        resolved,
        artifact,
        "denied",
        "transport-media-unsupported",
      );
      return;
    }

    const decision = await egress.policy.authorizeAndReserve({
      role: resolved.role,
      artifact,
      budget,
    });
    if (decision.status === "deny") {
      await this.#auditArtifactEgress(
        resolved,
        artifact,
        "denied",
        decision.reason,
      );
      return;
    }

    try {
      await mediaTransport.sendMedia({
        conversationId: deliveryConversationId,
        ...decision.media,
      });
      await this.store.appendAudit({
        userId: resolved.userId,
        conversationId: resolved.conversationId,
        eventType: "artifact.egress_sent",
        payload: {
          artifactId: artifact.id,
          kind: artifact.kind,
          sourceCapability: decision.sourceCapability,
          bytes: decision.byteLength,
        },
      });
    } catch (error) {
      await this.store.appendAudit({
        userId: resolved.userId,
        conversationId: resolved.conversationId,
        eventType: "artifact.egress_failed",
        payload: {
          artifactId: artifact.id,
          kind: artifact.kind,
          errorType: error instanceof Error ? error.name : "unknown",
        },
      }).catch(() => undefined);
      process.stderr.write(
        `artifact.egress_failed=${safeLogToken(
          error instanceof Error ? error.name : "Error",
        )}\n`,
      );
    }
  }

  async #auditArtifactEgress(
    resolved: ResolvedGatewayIdentity,
    artifact: Extract<AgentEvent, { type: "artifact.available" }>["artifact"],
    outcome: "denied",
    reason: string,
  ): Promise<void> {
    await this.store.appendAudit({
      userId: resolved.userId,
      conversationId: resolved.conversationId,
      eventType: "artifact.egress_denied",
      payload: {
        artifactId: artifact.id,
        kind: artifact.kind,
        outcome,
        reason,
      },
    }).catch(() => undefined);
    process.stderr.write(
      `artifact.egress_denied=${safeLogToken(reason)} kind=${safeLogToken(artifact.kind)}\n`,
    );
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

  #setConversationActivity(
    conversationId: string,
    state: ConversationActivityState,
  ): void {
    if (!supportsConversationActivity(this.transport)) return;
    void this.transport.setConversationActivity(conversationId, state).catch((error) => {
      process.stderr.write(
        `transport.activity_error=${safeLogToken(
          error instanceof Error ? error.name : "Error",
        )}\n`,
      );
    });
  }

  async #send(conversationId: string, text: string): Promise<void> {
    await this.transport.send({ conversationId, text });
  }
}

function visibleActivityProgress(toolName: string | undefined): {
  text: string;
  category: "search" | "reading" | "tool" | "thinking";
} {
  const normalized = toolName?.toLowerCase() ?? "";
  if (/(?:search|searx|web)/u.test(normalized)) {
    return { text: "正在搜索相关信息…", category: "search" };
  }
  if (/(?:read|file|list|grep|find)/u.test(normalized)) {
    return { text: "正在读取相关资料…", category: "reading" };
  }
  if (normalized) {
    return { text: "正在处理工具结果…", category: "tool" };
  }
  return { text: "正在处理，请稍候…", category: "thinking" };
}

function approvalCommandReply(
  _command: "approve" | "deny",
  outcome: "approved" | "denied" | "not-found" | "not-authorized",
): string {
  if (outcome === "approved") return "一次性授权已批准。";
  if (outcome === "denied") return "一次性授权已拒绝。";
  return "未找到可由当前会话处理的有效审批，可能已处理、过期或不属于当前会话。";
}

function formatSafeAgentFailure(error: unknown): string {
  const record = typeof error === "object" && error !== null
    ? error as Record<string, unknown>
    : undefined;
  const type = error instanceof Error ? error.name : "unknown";
  const kind = typeof record?.kind === "string" ? record.kind : "unknown";
  const method = typeof record?.method === "string" ? record.method : "unknown";
  const code = typeof record?.code === "number" ? String(record.code) : "none";
  const reason = error instanceof Error ? safeLogMessage(error.message) : '"unknown"';
  return `agent.run_failed.type=${safeLogToken(type)} kind=${safeLogToken(kind)} method=${safeLogToken(method)} code=${safeLogToken(code)} reason=${reason}`;
}

function safeLogMessage(value: string): string {
  const redacted = value
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/((?:api[_-]?key|token|secret|password)\s*[=:]\s*)[^\s,;]+/giu, "$1<redacted>")
    .replace(/([?&](?:api[_-]?key|token|secret|password)=)[^&\s]+/giu, "$1<redacted>")
    .replace(/Bearer\s+[^\s,;]+/giu, "Bearer <redacted>")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 320);
  return JSON.stringify(redacted || "unknown");
}

function safeLogToken(value: string): string {
  return value.replace(/[^A-Za-z0-9_.\/-]/g, "_").slice(0, 96) || "unknown";
}
