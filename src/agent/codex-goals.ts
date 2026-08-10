import {
  supportsAgentGoals,
  type AgentGoal,
  type AgentGoalRuntime,
  type AgentGoalStatus,
  type AgentRuntime,
} from "../core/contracts.js";

export interface GoalSetInput {
  threadId: string;
  objective?: string | null | undefined;
  status?: AgentGoalStatus | null | undefined;
  tokenBudget?: number | null | undefined;
}

export function requireGoalRuntime(runtime: AgentRuntime): AgentGoalRuntime {
  if (!supportsAgentGoals(runtime)) {
    throw new Error("Managed Codex runtime does not expose thread goals");
  }
  return runtime;
}

export class CodexGoalClient {
  constructor(
    private readonly request: (method: string, params: Record<string, unknown>) => Promise<unknown>,
    private readonly protocolError: (message: string) => Error,
  ) {}

  async get(threadId: string): Promise<AgentGoal | undefined> {
    const normalized = requireGoalThreadId(threadId);
    const response = plainRecord(await this.request("thread/goal/get", { threadId: normalized }));
    if (response?.goal === null || response?.goal === undefined) return undefined;
    return parseGoalResponse(response.goal, normalized, this.protocolError);
  }

  async set(input: GoalSetInput): Promise<AgentGoal> {
    const params = buildGoalSetParams(input);
    const threadId = String(params.threadId);
    const response = plainRecord(await this.request("thread/goal/set", params));
    if (response?.goal === null || response?.goal === undefined) {
      throw this.protocolError("thread/goal/set returned no goal");
    }
    return parseGoalResponse(response.goal, threadId, this.protocolError);
  }

  async clear(threadId: string): Promise<boolean> {
    const normalized = requireGoalThreadId(threadId);
    const response = plainRecord(await this.request("thread/goal/clear", { threadId: normalized }));
    if (typeof response?.cleared !== "boolean") {
      throw this.protocolError("thread/goal/clear returned invalid cleared state");
    }
    return response.cleared;
  }
}

export function readGoalDynamicCall(
  paramsValue: unknown,
  activeTurnId: string | undefined,
): { threadId: string; tool: string; arguments: Record<string, unknown> } | undefined {
  const params = plainRecord(paramsValue);
  const threadId = typeof params?.threadId === "string" ? params.threadId : undefined;
  const turnId = typeof params?.turnId === "string" ? params.turnId : undefined;
  const tool = typeof params?.tool === "string" ? params.tool : undefined;
  const argumentsValue = plainRecord(params?.arguments);
  return threadId && turnId === activeTurnId && tool && argumentsValue
    ? { threadId, tool, arguments: argumentsValue } : undefined;
}

const GOAL_STATUSES = new Set<AgentGoalStatus>([
  "active", "paused", "blocked", "usageLimited", "budgetLimited", "complete",
]);

export function requireGoalThreadId(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error("Thread id must not be empty");
  return normalized;
}

export function buildGoalSetParams(input: GoalSetInput): Record<string, unknown> {
  const params: Record<string, unknown> = { threadId: requireGoalThreadId(input.threadId) };
  if (input.objective !== undefined) {
    if (input.objective === null) params.objective = null;
    else {
      const objective = input.objective.trim();
      if (!objective || objective.length > 4_000) {
        throw new Error("Goal objective must contain 1 to 4000 characters");
      }
      params.objective = objective;
    }
  }
  if (input.status !== undefined) {
    if (input.status !== null && !isGoalStatus(input.status)) throw new Error("Invalid Goal status");
    params.status = input.status;
  }
  if (input.tokenBudget !== undefined) {
    if (input.tokenBudget !== null
      && (!Number.isSafeInteger(input.tokenBudget) || input.tokenBudget <= 0)) {
      throw new Error("Goal token budget must be a positive safe integer or null");
    }
    params.tokenBudget = input.tokenBudget;
  }
  if (Object.keys(params).length === 1) {
    throw new Error("Goal update must provide objective, status, or token budget");
  }
  return params;
}

export function parseGoalResponse(
  value: unknown,
  expectedThreadId: string,
  protocolError: (message: string) => Error,
): AgentGoal {
  const goal = plainRecord(value);
  const threadId = typeof goal?.threadId === "string" ? goal.threadId.trim() : "";
  const objective = typeof goal?.objective === "string" ? goal.objective.trim() : "";
  const status = goal?.status;
  const tokenBudget = goal?.tokenBudget;
  const tokensUsed = finiteNonNegative(goal?.tokensUsed);
  const timeUsedSeconds = finiteNonNegative(goal?.timeUsedSeconds);
  const createdAt = finiteNonNegative(goal?.createdAt);
  const updatedAt = finiteNonNegative(goal?.updatedAt);
  if (!goal || threadId !== expectedThreadId || !objective || objective.length > 4_000
    || !isGoalStatus(status)
    || !(tokenBudget === null || (Number.isSafeInteger(tokenBudget) && Number(tokenBudget) > 0))
    || tokensUsed === undefined || timeUsedSeconds === undefined
    || createdAt === undefined || updatedAt === undefined) {
    throw protocolError("thread/goal response is invalid");
  }
  return {
    threadId, objective, status, tokenBudget: tokenBudget as number | null,
    tokensUsed, timeUsedSeconds, createdAt, updatedAt,
  };
}

export async function executeGoalDynamicTool(input: {
  threadId: string;
  tool: string;
  arguments: Record<string, unknown>;
  getGoal: () => Promise<AgentGoal | undefined>;
  setGoal: (input: GoalSetInput) => Promise<AgentGoal>;
  clearGoal: () => Promise<boolean>;
}): Promise<{ success: boolean; text: string }> {
  try {
    if (input.tool === "status") {
      const goal = await input.getGoal();
      return { success: true, text: goal ? formatGoalForTool(goal) : "goal=absent" };
    }
    if (input.tool === "clear") {
      return { success: true, text: `goal=${await input.clearGoal() ? "cleared" : "absent"}` };
    }
    if (input.tool === "create") {
      const objective = typeof input.arguments.objective === "string"
        ? input.arguments.objective.trim() : "";
      const tokenBudget = input.arguments.token_budget;
      if (!objective || objective.length > 4_000 || (tokenBudget !== undefined
        && (!Number.isSafeInteger(tokenBudget) || Number(tokenBudget) <= 0))) throw new Error();
      const goal = await input.setGoal({
        threadId: input.threadId, objective, status: "active",
        ...(tokenBudget !== undefined ? { tokenBudget: Number(tokenBudget) } : {}),
      });
      return { success: true, text: formatGoalForTool(goal) };
    }
    if (input.tool === "update") {
      const status = input.arguments.status;
      const tokenBudget = input.arguments.token_budget;
      const allowedStatus = status === undefined || status === "active" || status === "paused"
        || status === "blocked" || status === "complete";
      const allowedBudget = tokenBudget === undefined || tokenBudget === null
        || (Number.isSafeInteger(tokenBudget) && Number(tokenBudget) > 0);
      if (!allowedStatus || !allowedBudget || (status === undefined && tokenBudget === undefined)) {
        throw new Error();
      }
      const goal = await input.setGoal({
        threadId: input.threadId,
        ...(status !== undefined ? { status: status as AgentGoalStatus } : {}),
        ...(tokenBudget !== undefined ? { tokenBudget: tokenBudget as number | null } : {}),
      });
      return { success: true, text: formatGoalForTool(goal) };
    }
    return { success: false, text: "goal=denied\nreason=unsupported-tool" };
  } catch {
    return { success: false, text: "goal=failed\nreason=invalid-request-or-native-rpc" };
  }
}

function isGoalStatus(value: unknown): value is AgentGoalStatus {
  return typeof value === "string" && GOAL_STATUSES.has(value as AgentGoalStatus);
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function formatGoalForTool(goal: AgentGoal): string {
  return [
    "goal=present", `status=${goal.status}`,
    `objective=${goal.objective.replace(/[\u0000-\u001F\u007F]+/gu, " ").slice(0, 4_000)}`,
    `token_budget=${goal.tokenBudget === null ? "none" : String(goal.tokenBudget)}`,
    `tokens_used=${String(goal.tokensUsed)}`, `time_used_seconds=${String(goal.timeUsedSeconds)}`,
    `created_at=${String(goal.createdAt)}`, `updated_at=${String(goal.updatedAt)}`,
    "authority=codex-app-server-thread-goal",
  ].join("\n");
}
