import type {
  AgentGoalRuntime,
  AgentRuntime,
  AgentStatusSnapshot,
  ChatTransport,
} from "../core/contracts.js";
import {
  supportsAgentGoals,
  supportsStatusCardTransport,
} from "../core/contracts.js";
import type {
  AgentEvent,
  AuditEventInput,
  ResolvedGatewayIdentity,
} from "../core/types.js";
import { AgentStatusCardController } from "./agent-status-card-controller.js";
import {
  handleGoalControl,
  type GoalControlHost,
  type GoalStatusControlAction,
} from "./gateway-goal-control.js";

export { parseStatusControlAction } from "./gateway-goal-control.js";

export interface GoalStatusFacadeOptions {
  agent: AgentRuntime;
  transport: ChatTransport;
  audit: (event: AuditEventInput) => Promise<void>;
  send: (deliveryConversationId: string, text: string) => Promise<void>;
  isConversationBusy: (conversationId: string) => boolean;
  resolveProjectContext: (
    deliveryConversationId: string,
    conversationId: string,
  ) => Promise<{
    threadId: string;
    projectName: string;
    projectCwd: string;
  } | undefined>;
  stopConversation: (conversationId: string) => Promise<unknown>;
  statusCard: {
    enabled: boolean;
    updateIntervalMs: number;
    autoPin: boolean;
  };
}

export class GoalStatusFacade {
  readonly statusCard: AgentStatusCardController | undefined;
  readonly #agent: AgentGoalRuntime;
  readonly #options: Omit<GoalStatusFacadeOptions, "statusCard">;

  constructor(options: GoalStatusFacadeOptions) {
    if (!supportsAgentGoals(options.agent)) {
      throw new Error("Goal status facade requires an Agent Goal runtime");
    }
    this.#agent = options.agent;
    this.#options = options;
    this.statusCard = options.statusCard.enabled
      && supportsStatusCardTransport(options.transport)
      ? new AgentStatusCardController({
          transport: options.transport,
          audit: options.audit,
          enabled: true,
          updateIntervalMs: options.statusCard.updateIntervalMs,
          autoPin: options.statusCard.autoPin,
        })
      : undefined;
  }

  async start(): Promise<void> {
    await this.statusCard?.start().catch(() => undefined);
  }

  async stop(): Promise<void> {
    await this.statusCard?.stop().catch(() => undefined);
  }

  async onRunStarted(
    conversationId: string,
    deliveryConversationId: string,
    projectName: string | undefined,
  ): Promise<void> {
    await this.statusCard?.onRunStarted(
      deliveryConversationId,
      await this.statusSnapshot(conversationId, deliveryConversationId, "running", {
        ...(projectName ? { projectName } : {}),
        lastActivity: "任务开始",
      }),
    ).catch(() => undefined);
  }

  async onRunEvent(
    deliveryConversationId: string,
    event: AgentEvent,
  ): Promise<void> {
    if (event.type !== "tool.started" && event.type !== "tool.completed") return;
    await this.statusCard?.onRunEvent(deliveryConversationId, {
      state: "running",
      turnNumber: 0,
      elapsedMs: 0,
      lastActivity: event.type === "tool.started"
        ? `正在使用工具 ${event.name}`
        : `工具完成 ${event.name}`,
    }).catch(() => undefined);
  }

  async onRunEnded(
    conversationId: string,
    deliveryConversationId: string,
    projectName: string | undefined,
  ): Promise<void> {
    await this.statusCard?.onRunEnded(
      deliveryConversationId,
      await this.statusSnapshot(conversationId, deliveryConversationId, "idle", {
        ...(projectName ? { projectName } : {}),
      }),
    ).catch(() => undefined);
  }

  async onRunFailed(
    conversationId: string,
    deliveryConversationId: string,
  ): Promise<void> {
    await this.statusCard?.onStopped(
      deliveryConversationId,
      await this.statusSnapshot(conversationId, deliveryConversationId, "stopped"),
    ).catch(() => undefined);
  }

  async onStopped(
    conversationId: string,
    deliveryConversationId: string,
  ): Promise<void> {
    await this.statusCard?.onStopped(
      deliveryConversationId,
      await this.statusSnapshot(conversationId, deliveryConversationId, "stopped"),
    ).catch(() => undefined);
  }

  async handleStatusControl(
    resolved: ResolvedGatewayIdentity,
    deliveryConversationId: string,
    action: GoalStatusControlAction,
  ): Promise<void> {
    const outcome = await handleGoalControl({
      host: this.#host(),
      resolved,
      deliveryConversationId,
      action,
      source: "status-card",
    });
    if (outcome === "paused" || outcome === "stopped") {
      await this.onStopped(resolved.conversationId, deliveryConversationId);
    }
  }

  async handleContinue(
    resolved: ResolvedGatewayIdentity,
    deliveryConversationId: string,
  ): Promise<void> {
    await handleGoalControl({
      host: this.#host(),
      resolved,
      deliveryConversationId,
      action: "continue",
      source: "command",
    });
  }

  async handleRestart(
    resolved: ResolvedGatewayIdentity,
    deliveryConversationId: string,
  ): Promise<void> {
    await handleGoalControl({
      host: this.#host(),
      resolved,
      deliveryConversationId,
      action: "restart",
      source: "command",
    });
  }

  async statusSnapshot(
    conversationId: string,
    deliveryConversationId: string,
    state: AgentStatusSnapshot["state"],
    extra: Partial<Pick<
      AgentStatusSnapshot,
      "projectName" | "turnNumber" | "lastActivity" | "goal"
    >> = {},
  ): Promise<AgentStatusSnapshot> {
    const context = await this.#options.resolveProjectContext(
      deliveryConversationId,
      conversationId,
    ).catch(() => undefined);
    const goal = context?.threadId
      ? await this.#agent.getGoal(context.threadId, { cwd: context.projectCwd })
          .catch(() => undefined)
      : undefined;
    return {
      state,
      projectName: extra.projectName ?? context?.projectName,
      turnNumber: extra.turnNumber ?? 0,
      elapsedMs: 0,
      ...(extra.lastActivity ? { lastActivity: extra.lastActivity } : {}),
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

  #host(): GoalControlHost {
    return {
      agent: this.#agent,
      send: this.#options.send,
      audit: this.#options.audit,
      isConversationBusy: this.#options.isConversationBusy,
      resolveProjectContext: this.#options.resolveProjectContext,
      stopConversation: this.#options.stopConversation,
    };
  }
}
