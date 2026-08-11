import type {
  AgentGoal,
  AgentGoalRuntime,
  AgentRuntime,
  GoalContinuationRecord,
} from "../core/contracts.js";
import type { IncomingMessage } from "../core/types.js";

const CONTINUATION_TRANSPORT = "feishu" as const;

export type GoalContinuationScheduleCallback = () => void | Promise<void>;

export function supportsGoalRuntime(
  agent: AgentRuntime,
): agent is AgentRuntime & AgentGoalRuntime {
  return typeof (agent as Partial<AgentGoalRuntime>).getGoal === "function"
    && typeof (agent as Partial<AgentGoalRuntime>).setGoal === "function";
}

export function isRetryableGoalContinuationError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return (error as { retryable?: unknown }).retryable === true;
}

export function disableGoalContinuation(
  record: GoalContinuationRecord,
  now: number,
): void {
  record.enabled = false;
  record.pending = false;
  record.nextRunAt = null;
  record.updatedAt = now;
}

export function buildGoalContinuationMessage(
  record: GoalContinuationRecord,
  goal: AgentGoal,
  now: number,
): IncomingMessage {
  return {
    id: `goal-continuation:${record.threadId}:${record.turnCount}:${String(now)}`,
    identity: {
      transport: CONTINUATION_TRANSPORT,
      botId: "floral",
      externalUserId: record.userId,
      conversationId: record.deliveryConversationId,
    },
    text: [
      "[FLORAL Goal 自动续跑]",
      `第 ${String(record.turnCount)} 轮。当前 Goal 状态：${goal.status}。`,
      `目标：${goal.objective}`,
      "请继续推进上述跨轮 Goal，不要重复已经完成的工作，并严格遵守目标中明确写出的轮次/阶段边界。",
      "当前轮次完成不等于整个 Goal 完成。只要 objective 仍要求后续轮次、阶段、验证或收尾，就保持 Goal 为 active。",
      "当且仅当整个 objective 已真正完成时，调用 floral_goal/update 将 status 设为 complete；该更新会先写入本轮 projection，并在 turn/completed 后由 FLORAL 安全提交到 Codex 原生 Goal。不要使用 [GOAL_COMPLETE] 或其他文本标记代替 native Goal 状态。",
      "如果目标被真实阻塞，可以调用 floral_goal/update 将 status 设为 blocked；普通阶段性完成无需修改 Goal 状态。",
      "若需要更多信息，请明确说明还缺什么。",
      "如果目标只需要直接回答或总结，请直接完成，避免不必要的工具调用。",
    ].join("\n"),
    receivedAt: new Date(now),
  };
}
