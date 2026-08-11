import {
  supportsAgentGoals,
  type AgentRuntime,
} from "../core/contracts.js";
import type { AuditEventInput, GatewayRole } from "../core/types.js";
import type { GatewayCommand } from "./gateway-commands.js";
import type { GoalContinuationCoordinator } from "./goal-continuation-coordinator.js";
import { formatAgentGoal } from "./gateway-presentation.js";
type GoalCommand = Extract<GatewayCommand, { type: "goal" }>;
export async function handleGatewayGoalCommand(input: {
  agent: AgentRuntime;
  command: GoalCommand;
  threadId: string; projectCwd: string;
  projectName: string;
  deliveryConversationId: string;
  userId: string;
  conversationId: string;
  role: GatewayRole;
  busy: boolean;
  audit: (event: AuditEventInput) => Promise<void>;
  send: (text: string) => Promise<void>;
  continuation?: GoalContinuationCoordinator | undefined;
}): Promise<void> {
  const { agent, command } = input;
  if (command.action === "continue" || command.action === "restart") return;
  if (!supportsAgentGoals(agent)) {
    await input.send("当前 Agent runtime 未开放 Codex thread/goal 接口。");
    return;
  }
  const mutating = command.action !== "status";
  if (mutating && input.role !== "owner") {
    await input.audit({
      userId: input.userId,
      conversationId: input.conversationId,
      eventType: "command.goal_denied",
      payload: { reason: "owner-required", action: command.action },
    });
    await input.send("只有 owner 可以修改或清除 Goal。");
    return;
  }
  if (mutating && input.busy) {
    await input.send("当前任务运行中，不能从命令侧修改 Goal。请先使用 /stop，或让当前 Agent 按明确请求更新 Goal。");
    return;
  }
  if (command.action === "set" && !command.objective) {
    await input.send("用法：/goal set [--tokens <正整数|off>] <目标>。目标最多 4000 个字符。");
    return;
  }
  if (
    typeof command.tokenBudget === "number"
    && (!Number.isSafeInteger(command.tokenBudget) || command.tokenBudget <= 0)
  ) {
    await input.send("Goal token 预算必须是正整数。");
    return;
  }
  try {
    if (command.action === "clear") {
      const cleared = await agent.clearGoal(input.threadId, { cwd: input.projectCwd });
      await input.continuation?.delete(input.conversationId);
      await input.audit({
        userId: input.userId,
        conversationId: input.conversationId,
        eventType: "command.goal_cleared",
        payload: { projectName: input.projectName, cleared },
      });
      await input.send(cleared ? "当前 Codex Goal 已清除。" : "当前会话没有可清除的 Goal。");
      return;
    }
    const goal = command.action === "status"
      ? await agent.getGoal(input.threadId, { cwd: input.projectCwd })
      : await agent.setGoal({
          threadId: input.threadId,
          cwd: input.projectCwd,
          ...(command.action === "set"
            ? {
                objective: command.objective!,
                status: "active" as const,
                ...(command.tokenBudget !== undefined
                  ? { tokenBudget: command.tokenBudget }
                  : {}),
              }
            : {
                status: command.action === "pause" ? "paused" as const : command.action,
              }),
        });
    await input.continuation?.syncCommand({
      action: command.action as "set" | "active" | "pause" | "blocked" | "complete",
      threadId: input.threadId,
      projectCwd: input.projectCwd,
      projectName: input.projectName,
      deliveryConversationId: input.deliveryConversationId,
      conversationId: input.conversationId,
      userId: input.userId,
    });
    await input.audit({
      userId: input.userId,
      conversationId: input.conversationId,
      eventType: command.action === "status" ? "command.goal_status" : "command.goal_updated",
      payload: {
        projectName: input.projectName,
        action: command.action,
        present: Boolean(goal),
        ...(goal ? { status: goal.status, tokenBudget: goal.tokenBudget } : {}),
      },
    });
    const continuation = await input.continuation
      ?.getRecord(input.conversationId)
      .catch(() => undefined);
    await input.send(command.action === "set"
      ? "Goal 已设置并授权自动续跑。目标已固定在状态卡上；稍后开始第一轮。"
      : goal
        ? `${formatAgentGoal(goal)}\n${formatContinuationState(continuation)}`
        : "当前会话没有 Goal。");
  } catch (error) {
    const message = error instanceof Error
      ? error.message.replace(/\s+/gu, " ").trim().slice(0, 300)
      : "unknown error";
    await input.audit({
      userId: input.userId,
      conversationId: input.conversationId,
      eventType: "command.goal_failed",
      payload: { projectName: input.projectName, action: command.action, message },
    }).catch(() => undefined);
    await input.send("Codex Goal 操作失败。会话可能已归档、目标格式无效，或当前 app-server 版本不支持该接口。");
  }
}

function formatContinuationState(record: Awaited<ReturnType<GoalContinuationCoordinator["getRecord"]>>): string {
  if (!record?.authorized) return "自动续跑：未授权";
  if (!record.enabled) return `自动续跑：已停用（已完成 ${String(record.turnCount)} 轮）`;
  return record.pending
    ? `自动续跑：已启用，下一轮已排队（已完成 ${String(record.turnCount)} 轮）`
    : `自动续跑：已启用（已完成 ${String(record.turnCount)} 轮）`;
}
