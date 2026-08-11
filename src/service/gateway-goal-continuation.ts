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
} from "../core/contracts.js";
import type {
  AgentEvent,
  AuditEventInput,
  ResolvedGatewayIdentity,
} from "../core/types.js";
import { AgentStatusCardController } from "./agent-status-card-controller.js";
import {
  GoalContinuationCoordinator,
  type GoalContinuationRunInput,
} from "./goal-continuation-coordinator.js";
import { GoalStatusControlHandler } from "./goal-status-control.js";

export { parseStatusControlAction } from "./goal-status-control.js";

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
  readonly #statusControl: GoalStatusControlHandler;
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
    this.#statusControl = new GoalStatusControlHandler({
      agent: this.#agent,
      coordinator: this.coordinator,
      send: options.send,
      audit: options.audit,
      isConversationBusy: options.isConversationBusy,
      stopConversation: options.stopConversation,
      resolveProjectContext: options.resolveProjectContext,
    });
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
    action: "pause" | "stop" | "continue" | "restart",
  ): Promise<void> {
    await this.#statusControl.handleStatusControl(
      resolved,
      deliveryConversationId,
      action,
    );
    if (action === "pause" || action === "stop") {
      await this.onStopped(resolved.conversationId, deliveryConversationId);
    }
  }

  async handleContinue(
    resolved: ResolvedGatewayIdentity,
    deliveryConversationId: string,
  ): Promise<void> {
    await this.#statusControl.handleContinue(resolved, deliveryConversationId);
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
