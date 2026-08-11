import type {
  AgentGoal,
  AgentGoalRuntime,
} from "../core/contracts.js";
import { STATUS_CONTROL_MESSAGE_PREFIX } from "../core/contracts.js";
import type {
  AuditEventInput,
  ResolvedGatewayIdentity,
} from "../core/types.js";

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

export interface GoalControlHost {
  agent: AgentGoalRuntime;
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
}

export type GoalControlOutcome =
  | "paused"
  | "stopped"
  | "continued"
  | "restarted"
  | "ignored";

export async function handleGoalControl(input: {
  host: GoalControlHost;
  resolved: ResolvedGatewayIdentity;
  deliveryConversationId: string;
  action: GoalStatusControlAction;
  source: "status-card" | "command";
}): Promise<GoalControlOutcome> {
  const { host, resolved, deliveryConversationId, action } = input;
  if (resolved.role !== "owner") {
    await host.audit({
      userId: resolved.userId,
      conversationId: resolved.conversationId,
      eventType: input.source === "status-card"
        ? "status_control.denied"
        : "command.goal_control_denied",
      payload: { action, reason: "owner-required" },
    }).catch(() => undefined);
    await host.send(deliveryConversationId, "只有 owner 可以控制 Goal。");
    return "ignored";
  }

  if ((action === "continue" || action === "restart")
    && host.isConversationBusy(resolved.conversationId)) {
    if (action === "restart") {
      await host.stopConversation(resolved.conversationId);
    } else {
      await host.send(deliveryConversationId, "当前任务仍在运行，无需重复继续。请等待本轮结束，或先使用 /stop。");
      return "ignored";
    }
  }

  const context = await host.resolveProjectContext(
    deliveryConversationId,
    resolved.conversationId,
  );
  if (!context?.threadId) return "ignored";
  const goal = await host.agent.getGoal(context.threadId, {
    cwd: context.projectCwd,
  }).catch(() => undefined);

  if (action === "pause" || action === "stop") {
    await host.stopConversation(resolved.conversationId);
    if (action === "pause" && goal) {
      await host.agent.setGoal({
        threadId: context.threadId,
        cwd: context.projectCwd,
        status: "paused",
      }).catch(() => undefined);
    }
    await host.send(
      deliveryConversationId,
      action === "pause"
        ? "已暂停：当前任务已停止，Goal 已置为 paused。可在状态卡点击“继续”恢复。"
        : "已停止：当前任务已停止，Goal 状态保持不变。",
    );
    return action === "pause" ? "paused" : "stopped";
  }

  if (!goal) {
    await host.send(deliveryConversationId, "当前会话没有 Goal。请先使用 /goal set 创建目标。");
    return "ignored";
  }
  if (action === "continue" && goal.status === "complete") {
    await host.send(deliveryConversationId, "当前 Goal 已完成。如需再次执行，请点击“重新开始”或使用 /goal set 重新创建。");
    return "ignored";
  }
  if (goal.status === "usageLimited") {
    await host.send(deliveryConversationId, "当前 Goal 处于 usageLimited，不能直接继续；请先处理上游用量限制。");
    return "ignored";
  }
  if (goal.status === "budgetLimited"
    && goal.tokenBudget !== null
    && goal.tokensUsed >= goal.tokenBudget) {
    await host.send(deliveryConversationId, "当前 Goal 的 token 预算已耗尽。请先用 /goal set --tokens <新预算> <目标> 创建新的预算周期。");
    return "ignored";
  }

  if (goal.status !== "active") {
    await host.agent.setGoal({
      threadId: context.threadId,
      cwd: context.projectCwd,
      status: "active",
    }).catch(() => undefined);
  }
  await host.send(
    deliveryConversationId,
    action === "restart"
      ? "Goal 已重新置为 active。发送消息即可继续推进；Codex 原生 Goal 的累计用量统计仍由上游保留。"
      : "Goal 已恢复为 active。发送消息即可继续推进。",
  );
  return action === "restart" ? "restarted" : "continued";
}

export function canRestartGoal(goal: AgentGoal | undefined): boolean {
  if (!goal) return false;
  if (goal.status === "usageLimited") return false;
  return !(goal.status === "budgetLimited"
    && goal.tokenBudget !== null
    && goal.tokensUsed >= goal.tokenBudget);
}
