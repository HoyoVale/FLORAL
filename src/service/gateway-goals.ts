import {
  supportsAgentGoals,
  type AgentGoal,
  type AgentRuntime,
} from "../core/contracts.js";
import type { AuditEventInput, GatewayRole } from "../core/types.js";
import type { GatewayCommand } from "./gateway-commands.js";

type GoalCommand = Extract<GatewayCommand, { type: "goal" }>;

export async function handleGatewayGoalCommand(input: {
  agent: AgentRuntime;
  command: GoalCommand;
  threadId: string;
  projectName: string;
  userId: string;
  conversationId: string;
  role: GatewayRole;
  busy: boolean;
  audit: (event: AuditEventInput) => Promise<void>;
  send: (text: string) => Promise<void>;
}): Promise<void> {
  const { agent, command } = input;
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
      const cleared = await agent.clearGoal(input.threadId);
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
      ? await agent.getGoal(input.threadId)
      : await agent.setGoal({
          threadId: input.threadId,
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
    await input.send(goal ? formatAgentGoal(goal) : "当前会话没有 Goal。");
  } catch {
    await input.send("Codex Goal 操作失败。会话可能已归档、目标格式无效，或当前 app-server 版本不支持该接口。");
  }
}

function formatAgentGoal(goal: AgentGoal): string {
  const objective = goal.objective
    .replace(/[\u0000-\u001F\u007F]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return [
    "Codex Goal",
    `状态：${goal.status}`,
    `目标：${objective}`,
    `Token：${String(goal.tokensUsed)} / ${goal.tokenBudget === null ? "不限" : String(goal.tokenBudget)}`,
    `已用时间：${String(Math.round(goal.timeUsedSeconds))} 秒`,
  ].join("\n");
}
