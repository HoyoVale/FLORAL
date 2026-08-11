import type {
  AgentGoalRuntime,
} from "../core/contracts.js";
import { STATUS_CONTROL_MESSAGE_PREFIX } from "../core/contracts.js";
import type {
  AuditEventInput,
  ResolvedGatewayIdentity,
} from "../core/types.js";
import type { GoalContinuationCoordinator } from "./goal-continuation-coordinator.js";

export type GoalStatusControlAction = "pause" | "stop" | "continue" | "restart";

export function parseStatusControlAction(
  text: string,
): GoalStatusControlAction | undefined {
  if (!text.startsWith(`${STATUS_CONTROL_MESSAGE_PREFIX} `)) return undefined;
  const action = text.slice(STATUS_CONTROL_MESSAGE_PREFIX.length + 1).trim();
  return action === "pause" || action === "stop" || action === "continue"
    || action === "restart"
    ? action
    : undefined;
}

export interface GoalStatusControlDeps {
  agent: AgentGoalRuntime;
  coordinator: GoalContinuationCoordinator;
  send: (deliveryConversationId: string, text: string) => Promise<void>;
  audit: (event: AuditEventInput) => Promise<void>;
  isConversationBusy: (conversationId: string) => boolean;
  stopConversation: (conversationId: string) => Promise<{
    active: boolean;
    starting: boolean;
    queuedCount: number;
    interruptSent: boolean;
  }>;
  resolveProjectContext: (
    deliveryConversationId: string,
    conversationId: string,
  ) => Promise<{
    threadId: string;
    projectName: string;
    projectCwd: string;
  } | undefined>;
}

export class GoalStatusControlHandler {
  constructor(private readonly deps: GoalStatusControlDeps) {}

  async handleStatusControl(
    resolved: ResolvedGatewayIdentity,
    deliveryConversationId: string,
    action: GoalStatusControlAction,
  ): Promise<void> {
    if (resolved.role !== "owner") {
      await this.deps.audit({
        userId: resolved.userId,
        conversationId: resolved.conversationId,
        eventType: "status_control.denied",
        payload: { action },
      });
      await this.deps.send(deliveryConversationId, "只有 owner 可以控制状态卡。");
      return;
    }
    if (action === "pause" || action === "stop") {
      await this.deps.stopConversation(resolved.conversationId);
      if (action === "pause") {
        const context = await this.deps.resolveProjectContext(
          deliveryConversationId,
          resolved.conversationId,
        );
        if (context) {
          await this.deps.agent.setGoal({
            threadId: context.threadId,
            cwd: context.projectCwd,
            status: "paused",
          }).catch(() => undefined);
        }
        await this.deps.coordinator.stopContinuation(
          resolved.conversationId,
          "status-card-pause",
        );
        await this.deps.send(deliveryConversationId, "已暂停：当前任务已停止，Goal 已置为 paused。");
      } else {
        await this.deps.coordinator.stopContinuation(
          resolved.conversationId,
          "status-card-stop",
        );
        await this.deps.send(deliveryConversationId, "已停止：当前任务已停止，Goal 自动续跑已关闭。");
      }
      return;
    }
    if (this.deps.isConversationBusy(resolved.conversationId)) {
      await this.deps.send(deliveryConversationId, "当前任务运行中，不能执行该操作。请先 /stop。");
      return;
    }
    const context = await this.deps.resolveProjectContext(
      deliveryConversationId,
      resolved.conversationId,
    );
    if (!context?.threadId) return;

    if (action === "continue") {
      const goal = await this.deps.agent.getGoal(context.threadId, {
        cwd: context.projectCwd,
      }).catch(() => undefined);
      if (goal?.status === "paused") {
        await this.deps.agent.setGoal({
          threadId: context.threadId,
          cwd: context.projectCwd,
          status: "active",
        }).catch(() => undefined);
      }
      await this.deps.coordinator.setEnabled(resolved.conversationId, true);
      await this.deps.send(deliveryConversationId, "已继续：Goal 自动续跑已恢复。");
      return;
    }

    // restart: reset the native Goal to active and restart the loop from round 1.
    await this.deps.agent.setGoal({
      threadId: context.threadId,
      cwd: context.projectCwd,
      status: "active",
    }).catch(() => undefined);
    await this.deps.coordinator.authorize({
      conversationId: resolved.conversationId,
      deliveryConversationId,
      userId: resolved.userId,
      threadId: context.threadId,
      projectCwd: context.projectCwd,
      projectName: context.projectName,
      enable: true,
      resetProgress: true,
    });
    await this.deps.send(deliveryConversationId, "已重新运行：Goal 已置为 active，续跑从第 1 轮重新开始。");
  }

  async handleContinue(
    resolved: ResolvedGatewayIdentity,
    deliveryConversationId: string,
  ): Promise<void> {
    if (resolved.role !== "owner") {
      await this.deps.audit({
        userId: resolved.userId,
        conversationId: resolved.conversationId,
        eventType: "command.goal_continue_denied",
        payload: { reason: "owner-required" },
      });
      await this.deps.send(deliveryConversationId, "只有 owner 可以启用 Goal 自动续跑。");
      return;
    }
    if (this.deps.isConversationBusy(resolved.conversationId)) {
      await this.deps.send(deliveryConversationId, "当前任务运行中，不能启用 Goal 自动续跑。请先 /stop。");
      return;
    }
    const context = await this.deps.resolveProjectContext(
      deliveryConversationId,
      resolved.conversationId,
    );
    if (!context?.threadId) return;
    const goal = await this.deps.agent.getGoal(context.threadId, {
      cwd: context.projectCwd,
    }).catch(() => undefined);
    if (!goal) {
      await this.deps.send(deliveryConversationId, "当前会话没有 Goal。请先使用 /goal set 创建目标。");
      return;
    }
    await this.deps.coordinator.authorize({
      conversationId: resolved.conversationId,
      deliveryConversationId,
      userId: resolved.userId,
      threadId: context.threadId,
      projectCwd: context.projectCwd,
      projectName: context.projectName,
      enable: true,
    });
    await this.deps.send(
      deliveryConversationId,
      goal.status === "active"
        ? "Goal 自动续跑已启用。当前回合结束后将自动继续推进目标。"
        : `Goal 已授权自动续跑，但当前状态为 ${goal.status}；请先 /goal active 恢复。`,
    );
  }
}
