import type {
  AgentGoal,
  AgentGoalRuntime,
  AgentRuntime,
  AgentStatusSnapshot,
  ChatTransport,
  GatewayStore,
  GoalContinuationStore,
} from "../core/contracts.js";
import {
  supportsAgentGoals,
  supportsGoalContinuationStore,
  supportsStatusCardTransport,
  STATUS_CONTROL_MESSAGE_PREFIX,
} from "../core/contracts.js";
import type {
  AgentEvent,
  AuditEventInput,
  ResolvedGatewayIdentity,
} from "../core/types.js";
import { AgentStatusCardController } from "./agent-status-card-controller.js";
import {
  GoalContinuationCoordinator,
  hasGoalCompleteMarker,
  type GoalContinuationRunInput,
} from "./goal-continuation-coordinator.js";

export function parseStatusControlAction(
  text: string,
): "pause" | "stop" | undefined {
  if (!text.startsWith(`${STATUS_CONTROL_MESSAGE_PREFIX} `)) return undefined;
  const action = text.slice(STATUS_CONTROL_MESSAGE_PREFIX.length + 1).trim();
  return action === "pause" || action === "stop" ? action : undefined;
}

export interface GoalContinuationFacadeOptions {
  agent: AgentRuntime;
  store: GatewayStore;
  transport: ChatTransport;
  audit: (event: AuditEventInput) => Promise<void>;
  send: (deliveryConversationId: string, text: string) => Promise<void>;
  isConversationBusy: (conversationId: string) => boolean;
  runContinuation: (input: GoalContinuationRunInput) => Promise<void>;
  resolveProjectContext: (
    deliveryConversationId: string,
    conversationId: string,
  ) => Promise<{
    threadId: string;
    projectName: string;
    projectCwd: string;
  } | undefined>;
  stopConversation: (conversationId: string) => Promise<{
    active: boolean;
    starting: boolean;
    queuedCount: number;
    interruptSent: boolean;
  }>;
  goalContinuation: {
    enabled: boolean;
    cooldownMs: number;
    maxTurns: number;
    maxWallTimeMs: number;
  };
  statusCard: {
    enabled: boolean;
    updateIntervalMs: number;
    autoPin: boolean;
  };
}

export interface GoalContinuationSyncInput {
  action: "set" | "continue" | "active" | "pause" | "blocked" | "complete" | "clear";
  threadId: string;
  projectCwd: string;
  projectName: string;
  deliveryConversationId: string;
  conversationId: string;
  userId: string;
  goal?: AgentGoal | undefined;
}

export class GoalContinuationFacade {
  readonly coordinator: GoalContinuationCoordinator;
  readonly statusCard: AgentStatusCardController | undefined;
  readonly #agent: AgentGoalRuntime;
  readonly #options: Omit<GoalContinuationFacadeOptions, "goalContinuation" | "statusCard">;
  readonly #goalContinuationConfig: GoalContinuationFacadeOptions["goalContinuation"];
  readonly #statusCardConfig: GoalContinuationFacadeOptions["statusCard"];

  constructor(options: GoalContinuationFacadeOptions) {
    if (!supportsAgentGoals(options.agent)) {
      throw new Error("Goal continuation requires an Agent Goal runtime");
    }
    if (!supportsGoalContinuationStore(options.store)) {
      throw new Error("Goal continuation requires a continuation-capable store");
    }
    this.#agent = options.agent;
    this.#options = options;
    this.#goalContinuationConfig = options.goalContinuation;
    this.#statusCardConfig = options.statusCard;

    const continuationInput = {
      agent: options.agent,
      store: options.store as GoalContinuationStore,
      audit: options.audit,
      send: options.send,
      cooldownMs: options.goalContinuation.cooldownMs,
      maxTurns: options.goalContinuation.maxTurns,
      maxWallTimeMs: options.goalContinuation.maxWallTimeMs,
      isConversationBusy: options.isConversationBusy,
      runContinuation: options.runContinuation,
    };

    if (options.statusCard.enabled && supportsStatusCardTransport(options.transport)) {
      const statusCard = new AgentStatusCardController({
        transport: options.transport,
        audit: options.audit,
        enabled: options.statusCard.enabled,
        updateIntervalMs: options.statusCard.updateIntervalMs,
        autoPin: options.statusCard.autoPin,
      });
      this.statusCard = statusCard;
      this.coordinator = new GoalContinuationCoordinator({
        ...continuationInput,
        onCooldown: (snapshot) => {
          void statusCard.onCooldown(snapshot.conversationId, {
            state: "cooldown",
            turnNumber: snapshot.turnNumber,
            elapsedMs: 0,
            cooldownRemainingMs: snapshot.cooldownRemainingMs,
            goal: {
              status: snapshot.goal.status,
              objective: snapshot.goal.objective,
              tokensUsed: snapshot.goal.tokensUsed,
              tokenBudget: snapshot.goal.tokenBudget,
              timeUsedSeconds: snapshot.goal.timeUsedSeconds,
            },
          });
        },
      });
    } else {
      this.coordinator = new GoalContinuationCoordinator(continuationInput);
    }
  }

  async start(): Promise<void> {
    await this.statusCard?.start().catch(() => undefined);
    await this.coordinator.start();
  }

  async stop(): Promise<void> {
    await this.coordinator.stop().catch(() => undefined);
    await this.statusCard?.stop().catch(() => undefined);
  }

  async onUserMessage(
    conversationId: string,
    deliveryConversationId: string,
  ): Promise<void> {
    await this.coordinator.onUserMessage(conversationId).catch(() => undefined);
    await this.statusCard?.onUserInterrupt(deliveryConversationId).catch(() => undefined);
  }

  async shouldConsumeCompletionMarker(
    conversationId: string,
    finalText: string,
  ): Promise<boolean> {
    if (!hasGoalCompleteMarker(finalText)) return false;
    const record = await this.coordinator.getRecord(conversationId).catch(() => undefined);
    return Boolean(record?.authorized && record.enabled);
  }

  async onRunStarted(
    conversationId: string,
    deliveryConversationId: string,
    projectName: string | undefined,
  ): Promise<void> {
    const record = await this.coordinator.getRecord(conversationId)
      .catch(() => undefined);
    await this.statusCard?.onRunStarted(
      deliveryConversationId,
      await this.statusSnapshot(
        conversationId,
        deliveryConversationId,
        "running",
        {
          ...(projectName ? { projectName } : {}),
          turnNumber: record?.turnCount ?? 0,
          lastActivity: "任务开始",
        },
      ),
    ).catch(() => undefined);
  }

  async onRunEvent(
    deliveryConversationId: string,
    event: AgentEvent,
  ): Promise<void> {
    if (event.type !== "tool.started" && event.type !== "tool.completed") return;
    await this.statusCard?.onRunEvent(deliveryConversationId, {
      lastActivity: event.type === "tool.started"
        ? `正在使用工具 ${event.name}`
        : `工具完成 ${event.name}`,
    }).catch(() => undefined);
  }

  async onRunCompleted(input: {
    conversationId: string;
    deliveryConversationId: string;
    threadId: string;
    projectCwd: string;
    projectName: string;
    finalText?: string | undefined;
  }): Promise<void> {
    await this.coordinator.onRunCompleted({
      conversationId: input.conversationId,
      deliveryConversationId: input.deliveryConversationId,
      threadId: input.threadId,
      projectCwd: input.projectCwd,
      projectName: input.projectName,
      ...(input.finalText !== undefined ? { finalText: input.finalText } : {}),
    }).catch(() => undefined);
    const record = await this.coordinator.getRecord(input.conversationId).catch(() => undefined);
    // A scheduled continuation already drove the card into cooldown through
    // onCooldown. Do not overwrite that state with an idle card.
    if (record?.pending) return;
    await this.statusCard?.onRunEnded(
      input.deliveryConversationId,
      await this.statusSnapshot(
        input.conversationId,
        input.deliveryConversationId,
        "idle",
        { projectName: input.projectName || undefined },
      ),
    ).catch(() => undefined);
  }

  async onRunFailed(
    conversationId: string,
    deliveryConversationId: string,
    error: unknown,
  ): Promise<boolean> {
    const outcome = await this.coordinator.onRunFailed(conversationId, error)
      .catch(() => "ignored" as const);
    if (outcome === "retry-scheduled") {
      // onCooldown has already moved the live card into a retry/cooldown state.
      return true;
    }
    if (outcome === "terminal-goal") {
      await this.statusCard?.onRunEnded(
        deliveryConversationId,
        await this.statusSnapshot(
          conversationId,
          deliveryConversationId,
          "idle",
        ),
      ).catch(() => undefined);
      return true;
    }
    if (outcome === "stopped") {
      await this.statusCard?.onStopped(
        deliveryConversationId,
        await this.statusSnapshot(
          conversationId,
          deliveryConversationId,
          "stopped",
        ),
      ).catch(() => undefined);
      return true;
    }
    await this.statusCard?.onStopped(
      deliveryConversationId,
      await this.statusSnapshot(
        conversationId,
        deliveryConversationId,
        "stopped",
      ),
    ).catch(() => undefined);
    return false;
  }

  async stopContinuation(conversationId: string, reason: string): Promise<boolean> {
    return await this.coordinator.stopContinuation(conversationId, reason)
      .catch(() => false);
  }

  async onStopped(
    conversationId: string,
    deliveryConversationId: string,
  ): Promise<void> {
    await this.statusCard?.onStopped(
      deliveryConversationId,
      await this.statusSnapshot(
        conversationId,
        deliveryConversationId,
        "stopped",
      ),
    ).catch(() => undefined);
  }

  async handleStatusControl(
    resolved: ResolvedGatewayIdentity,
    deliveryConversationId: string,
    action: "pause" | "stop",
  ): Promise<void> {
    if (resolved.role !== "owner") {
      await this.#options.audit({
        userId: resolved.userId,
        conversationId: resolved.conversationId,
        eventType: "status_control.denied",
        payload: { action },
      });
      await this.#options.send(deliveryConversationId, "只有 owner 可以控制状态卡。");
      return;
    }
    await this.#options.stopConversation(resolved.conversationId);
    if (action === "pause") {
      const context = await this.#options.resolveProjectContext(
        deliveryConversationId,
        resolved.conversationId,
      );
      if (context) {
        await this.#agent.setGoal({
          threadId: context.threadId,
          cwd: context.projectCwd,
          status: "paused",
        }).catch(() => undefined);
      }
      await this.stopContinuation(resolved.conversationId, "status-card-pause");
      await this.#options.send(deliveryConversationId, "已暂停：当前任务已停止，Goal 已置为 paused。");
    } else {
      await this.stopContinuation(resolved.conversationId, "status-card-stop");
      await this.#options.send(deliveryConversationId, "已停止：当前任务已停止，Goal 自动续跑已关闭。");
    }
    await this.onStopped(resolved.conversationId, deliveryConversationId);
  }

  async handleContinue(
    resolved: ResolvedGatewayIdentity,
    deliveryConversationId: string,
  ): Promise<void> {
    if (resolved.role !== "owner") {
      await this.#options.audit({
        userId: resolved.userId,
        conversationId: resolved.conversationId,
        eventType: "command.goal_continue_denied",
        payload: { reason: "owner-required" },
      });
      await this.#options.send(deliveryConversationId, "只有 owner 可以启用 Goal 自动续跑。");
      return;
    }
    if (this.#options.isConversationBusy(resolved.conversationId)) {
      await this.#options.send(deliveryConversationId, "当前任务运行中，不能启用 Goal 自动续跑。请先 /stop。");
      return;
    }
    const context = await this.#options.resolveProjectContext(
      deliveryConversationId,
      resolved.conversationId,
    );
    if (!context?.threadId) return;
    const goal = await this.#agent.getGoal(context.threadId, {
      cwd: context.projectCwd,
    }).catch(() => undefined);
    if (!goal) {
      await this.#options.send(deliveryConversationId, "当前会话没有 Goal。请先使用 /goal set 创建目标。");
      return;
    }
    await this.coordinator.authorize({
      conversationId: resolved.conversationId,
      deliveryConversationId,
      userId: resolved.userId,
      threadId: context.threadId,
      projectCwd: context.projectCwd,
      projectName: context.projectName,
      enable: true,
    });
    await this.#options.send(
      deliveryConversationId,
      goal.status === "active"
        ? "Goal 自动续跑已启用。当前回合结束后将自动继续推进目标。"
        : `Goal 已授权自动续跑，但当前状态为 ${goal.status}；请先 /goal active 恢复。`,
    );
  }

  async syncGoalChange(input: GoalContinuationSyncInput): Promise<void> {
    switch (input.action) {
      case "set":
      case "continue":
        await this.coordinator.authorize({
          conversationId: input.conversationId,
          deliveryConversationId: input.deliveryConversationId,
          userId: input.userId,
          threadId: input.threadId,
          projectCwd: input.projectCwd,
          projectName: input.projectName,
          enable: true,
          ...(input.action === "set" ? { resetProgress: true } : {}),
        });
        return;
      case "active":
        await this.coordinator.setEnabled(input.conversationId, true);
        return;
      case "pause":
      case "blocked":
      case "complete":
        await this.coordinator.stopContinuation(
          input.conversationId,
          `goal-${input.action}`,
        );
        return;
      case "clear":
        await this.coordinator.delete(input.conversationId);
        return;
    }
  }

  async statusSnapshot(
    conversationId: string,
    deliveryConversationId: string,
    state: AgentStatusSnapshot["state"],
    extra: Partial<Pick<
      AgentStatusSnapshot,
      "projectName" | "turnNumber" | "lastActivity" | "cooldownRemainingMs" | "goal"
    >> = {},
  ): Promise<AgentStatusSnapshot> {
    const context = await this.#options.resolveProjectContext(
      deliveryConversationId,
      conversationId,
    ).catch(() => undefined);
    const goal = context?.threadId
      ? await this.#agent.getGoal(context.threadId, {
          cwd: context.projectCwd,
        }).catch(() => undefined)
      : undefined;
    const record = await this.coordinator.getRecord(conversationId).catch(() => undefined);
    return {
      state,
      projectName: extra.projectName ?? context?.projectName,
      turnNumber: extra.turnNumber ?? record?.turnCount ?? 0,
      elapsedMs: 0,
      ...(extra.lastActivity ? { lastActivity: extra.lastActivity } : {}),
      ...(extra.cooldownRemainingMs !== undefined
        ? { cooldownRemainingMs: extra.cooldownRemainingMs }
        : {}),
      ...(goal ? {
        goal: {
          status: goal.status,
          objective: goal.objective,
          tokensUsed: goal.tokensUsed,
          tokenBudget: goal.tokenBudget,
          timeUsedSeconds: goal.timeUsedSeconds,
        },
      } : {}),
    };
  }
}
