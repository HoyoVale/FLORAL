import type {
  AgentGoal,
  AgentGoalRuntime,
  AgentRuntime,
  GoalContinuationRecord,
  GoalContinuationStore,
} from "../core/contracts.js";
import type {
  AuditEventInput,
  IncomingMessage,
  ResolvedGatewayIdentity,
} from "../core/types.js";

export interface GoalContinuationRunInput {
  record: GoalContinuationRecord;
  goal: AgentGoal;
  turnNumber: number;
  message: IncomingMessage;
  resolved: ResolvedGatewayIdentity;
}

export interface GoalContinuationCooldownSnapshot {
  conversationId: string;
  turnNumber: number;
  goal: AgentGoal;
  cooldownRemainingMs: number;
}

export interface GoalContinuationCoordinatorOptions {
  agent: AgentRuntime;
  store: GoalContinuationStore;
  audit: (event: AuditEventInput) => Promise<void>;
  send?: (conversationId: string, text: string) => Promise<void>;
  cooldownMs: number;
  maxTurns: number;
  maxWallTimeMs: number;
  isConversationBusy: (conversationId: string) => boolean;
  runContinuation: (input: GoalContinuationRunInput) => Promise<void>;
  onCooldown?: (snapshot: GoalContinuationCooldownSnapshot) => void | undefined;
  now?: (() => number) | undefined;
  schedule?: ((callback: () => void, delayMs: number) => unknown) | undefined;
  cancelSchedule?: ((handle: unknown) => void) | undefined;
}

const CONTINUATION_TRANSPORT = "feishu" as const;
const MAX_CONTINUATION_RETRIES = 2;

type ResolvedGoalContinuationOptions = Omit<
  GoalContinuationCoordinatorOptions,
  "send" | "onCooldown" | "now" | "schedule" | "cancelSchedule"
> & {
  send?: GoalContinuationCoordinatorOptions["send"];
  onCooldown?: GoalContinuationCoordinatorOptions["onCooldown"];
  now: () => number;
  schedule: (callback: () => void, delayMs: number) => unknown;
  cancelSchedule: (handle: unknown) => void;
};

export class GoalContinuationCoordinator {
  readonly #agent: AgentGoalRuntime;
  readonly #options: ResolvedGoalContinuationOptions;
  readonly #pendingTimers = new Map<string, unknown>();
  readonly #retryCounts = new Map<string, number>();
  #started = false;
  #stopped = false;

  constructor(options: GoalContinuationCoordinatorOptions) {
    if (!supportsGoalRuntime(options.agent)) {
      throw new Error("Goal continuation requires an Agent Goal runtime");
    }
    this.#agent = options.agent;
    this.#options = {
      ...options,
      now: options.now ?? (() => Date.now()),
      schedule: options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs)),
      cancelSchedule: options.cancelSchedule
        ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)),
    };
  }

  async start(): Promise<void> {
    if (this.#started) return;
    if (this.#stopped) throw new Error("Goal continuation cannot restart after stop");
    this.#started = true;
    for (const record of await this.#options.store.listGoalContinuations()) {
      if (!record.pending) continue;
      record.pending = false;
      record.nextRunAt = null;
      // We cannot prove whether the pre-crash turn performed side effects, so
      // never silently resume it. Make the quarantine explicit instead of
      // leaving an enabled-but-unscheduled continuation zombie.
      record.enabled = false;
      record.updatedAt = this.#options.now();
      await this.#options.store.saveGoalContinuation(record);
      await this.#audit({
        eventType: "goal.continuation_quarantined",
        payload: {
          conversationId: record.conversationId,
          threadId: record.threadId,
          reason: "service-restart",
        },
      });
      await this.#notify(
        record.deliveryConversationId,
        "Goal 自动续跑因 FLORAL 服务重启已安全暂停，避免重复执行未确认的副作用。确认当前状态后可使用 /goal continue 重新启用。",
      );
    }
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#started = false;
    for (const handle of this.#pendingTimers.values()) {
      this.#options.cancelSchedule(handle);
    }
    this.#pendingTimers.clear();
  }

  async authorize(input: {
    conversationId: string;
    deliveryConversationId: string;
    userId: string;
    threadId: string;
    projectCwd: string;
    projectName: string;
    enable: boolean;
    resetProgress?: boolean | undefined;
  }): Promise<void> {
    const now = this.#options.now();
    const existing = await this.#options.store.loadGoalContinuation(input.conversationId);
    const record: GoalContinuationRecord = existing ?? {
      conversationId: input.conversationId,
      deliveryConversationId: input.deliveryConversationId,
      userId: input.userId,
      role: "owner",
      threadId: input.threadId,
      projectCwd: input.projectCwd,
      projectName: input.projectName,
      authorized: true,
      enabled: input.enable,
      pending: false,
      nextRunAt: null,
      turnCount: 0,
      lastRunAt: null,
      createdAt: now,
      updatedAt: now,
    };
    record.authorized = true;
    record.enabled = input.enable;
    record.deliveryConversationId = input.deliveryConversationId;
    record.threadId = input.threadId;
    record.projectCwd = input.projectCwd;
    record.projectName = input.projectName;
    if (input.resetProgress) {
      record.turnCount = 0;
      record.lastRunAt = null;
      record.createdAt = now;
      this.#retryCounts.delete(input.conversationId);
    }
    record.updatedAt = now;
    await this.#cancelPending(record);
    await this.#options.store.saveGoalContinuation(record);
    await this.#audit({
      userId: input.userId,
      conversationId: input.conversationId,
      eventType: input.enable
        ? "goal.continuation_authorized"
        : "goal.continuation_disabled",
      payload: {
        threadId: input.threadId,
        projectName: input.projectName,
        turnCount: record.turnCount,
      },
    });
    if (input.enable) await this.#scheduleNext(record);
  }

  async setEnabled(conversationId: string, enabled: boolean): Promise<void> {
    const record = await this.#options.store.loadGoalContinuation(conversationId);
    if (!record) return;
    record.enabled = enabled;
    record.updatedAt = this.#options.now();
    await this.#cancelPending(record);
    await this.#options.store.saveGoalContinuation(record);
    await this.#audit({
      conversationId,
      eventType: enabled
        ? "goal.continuation_enabled"
        : "goal.continuation_disabled",
      payload: { threadId: record.threadId },
    });
    if (enabled) await this.#scheduleNext(record);
  }

  async syncCommand(input: {
    action: "set" | "active" | "pause" | "blocked" | "complete";
    threadId: string;
    projectCwd: string;
    projectName: string;
    deliveryConversationId: string;
    conversationId: string;
    userId: string;
  }): Promise<void> {
    if (input.action === "set") {
      await this.authorize({
        conversationId: input.conversationId,
        deliveryConversationId: input.deliveryConversationId,
        userId: input.userId,
        threadId: input.threadId,
        projectCwd: input.projectCwd,
        projectName: input.projectName,
        enable: true,
        resetProgress: true,
      });
      return;
    }
    if (input.action === "active") {
      await this.setEnabled(input.conversationId, true);
      return;
    }
    await this.stopContinuation(input.conversationId, `goal-${input.action}`);
  }

  async delete(conversationId: string): Promise<void> {
    await this.#cancelTimers(conversationId);
    await this.#options.store.deleteGoalContinuation(conversationId);
    await this.#audit({
      conversationId,
      eventType: "goal.continuation_deleted",
      payload: {},
    });
  }

  async onUserMessage(conversationId: string): Promise<void> {
    const record = await this.#options.store.loadGoalContinuation(conversationId);
    if (!record?.pending) return;
    record.pending = false;
    record.nextRunAt = null;
    record.updatedAt = this.#options.now();
    await this.#cancelTimers(conversationId);
    await this.#options.store.saveGoalContinuation(record);
    await this.#audit({
      conversationId,
      eventType: "goal.continuation_superseded",
      payload: { threadId: record.threadId },
    });
  }

  async onRunCompleted(input: {
    conversationId: string;
    deliveryConversationId: string;
    threadId: string;
    projectCwd: string;
    projectName: string;
    finalText?: string | undefined;
  }): Promise<void> {
    if (!this.#started || this.#stopped) return;
    const record = await this.#options.store.loadGoalContinuation(input.conversationId);
    if (!record?.authorized || !record.enabled) return;
    record.threadId = input.threadId;
    record.deliveryConversationId = input.deliveryConversationId;
    record.projectCwd = input.projectCwd;
    record.projectName = input.projectName;
    this.#retryCounts.delete(input.conversationId);
    await this.#options.store.saveGoalContinuation(record);
    await this.#scheduleNext(record);
  }

  async onRunFailed(
    conversationId: string,
    error: unknown,
  ): Promise<"ignored" | "retry-scheduled" | "terminal-goal" | "stopped"> {
    const record = await this.#options.store.loadGoalContinuation(conversationId);
    if (!record?.authorized || !record.enabled) return "ignored";
    const retryable = isRetryableError(error);
    const retries = this.#retryCounts.get(conversationId) ?? 0;
    const goal = await this.#getGoal(record);
    if (goal && goal.status !== "active") {
      record.enabled = false;
      record.pending = false;
      record.nextRunAt = null;
      record.updatedAt = this.#options.now();
      await this.#cancelTimers(conversationId);
      await this.#options.store.saveGoalContinuation(record);
      await this.#audit({
        conversationId,
        eventType: "goal.continuation_reconciled_terminal_goal",
        payload: { threadId: record.threadId, goalStatus: goal.status, afterRunFailure: true },
      });
      return "terminal-goal";
    }
    if (
      retryable
      && retries < MAX_CONTINUATION_RETRIES
      && !this.#stopped
      && goal
      && goal.status === "active"
    ) {
      this.#retryCounts.set(conversationId, retries + 1);
      record.updatedAt = this.#options.now();
      await this.#cancelPending(record);
      await this.#options.store.saveGoalContinuation(record);
      await this.#audit({
        conversationId,
        eventType: "goal.continuation_retry_scheduled",
        payload: {
          threadId: record.threadId,
          attempt: retries + 1,
          maxAttempts: MAX_CONTINUATION_RETRIES,
          errorType: error instanceof Error ? error.name : "Error",
        },
      });
      await this.#notify(
        record.deliveryConversationId,
        [
          `本轮 Goal 自动续跑失败（${error instanceof Error ? error.name : "Error"}）。`,
          `将在 ${String(Math.round(this.#options.cooldownMs / 1_000))} 秒后自动重试（第 ${String(retries + 1)}/${String(MAX_CONTINUATION_RETRIES)} 次）。`,
        ].join("\n"),
      );
      await this.#scheduleNext(record);
      return "retry-scheduled";
    }
    record.enabled = false;
    record.updatedAt = this.#options.now();
    await this.#cancelPending(record);
    await this.#options.store.saveGoalContinuation(record);
    await this.#audit({
      conversationId,
      eventType: "goal.continuation_stopped",
      payload: {
        threadId: record.threadId,
        reason: "run-failed",
        errorType: error instanceof Error ? error.name : "Error",
      },
    });
    await this.#notify(record.deliveryConversationId, [
      "Goal 自动续跑因任务失败而停止。",
      "可检查日志后使用 /goal continue 重新启用。",
    ].join("\n"));
    return "stopped";
  }

  async stopContinuation(conversationId: string, reason: string): Promise<boolean> {
    const record = await this.#options.store.loadGoalContinuation(conversationId);
    if (!record?.authorized) return false;
    record.enabled = false;
    record.updatedAt = this.#options.now();
    await this.#cancelPending(record);
    await this.#options.store.saveGoalContinuation(record);
    await this.#audit({
      conversationId,
      eventType: "goal.continuation_stopped",
      payload: { threadId: record.threadId, reason },
    });
    return true;
  }

  async getRecord(
    conversationId: string,
  ): Promise<GoalContinuationRecord | undefined> {
    return await this.#options.store.loadGoalContinuation(conversationId);
  }

  async #scheduleNext(record: GoalContinuationRecord): Promise<void> {
    if (!record.enabled || !record.authorized) return;
    if (record.pending && record.nextRunAt !== null) return;
    const goal = await this.#getGoal(record);
    if (!goal) {
      // The native Goal may be briefly invisible right after /goal set or a
      // deferred commit. Absent is not a terminal state: keep continuation
      // enabled and wait for the next reconciliation instead of disabling it.
      await this.#audit({
        conversationId: record.conversationId,
        eventType: "goal.continuation_goal_absent",
        payload: { threadId: record.threadId },
      });
      return;
    }
    if (goal.status !== "active") {
      // Keep the persisted continuation state aligned with native Goal
      // authority. Otherwise a Goal completed/paused by the Agent can leave an
      // enabled-but-inert continuation zombie behind.
      record.enabled = false;
      record.pending = false;
      record.nextRunAt = null;
      record.updatedAt = this.#options.now();
      await this.#cancelTimers(record.conversationId);
      await this.#options.store.saveGoalContinuation(record);
      await this.#audit({
        conversationId: record.conversationId,
        eventType: "goal.continuation_reconciled_terminal_goal",
        payload: {
          threadId: record.threadId,
          goalStatus: goal.status,
        },
      });
      return;
    }
    if (goal.tokenBudget !== null && goal.tokensUsed >= goal.tokenBudget) {
      await this.#budgetLimited(record, goal);
      return;
    }
    if (this.#options.maxTurns > 0 && record.turnCount >= this.#options.maxTurns) {
      await this.#turnLimitReached(record, goal);
      return;
    }
    if (this.#options.maxWallTimeMs > 0
      && this.#options.now() - record.createdAt >= this.#options.maxWallTimeMs) {
      await this.#wallTimeReached(record, goal);
      return;
    }

    const now = this.#options.now();
    const firstRun = record.lastRunAt === null;
    const delayMs = firstRun ? Math.min(this.#options.cooldownMs, 1_000) : this.#options.cooldownMs;
    record.pending = true;
    record.nextRunAt = now + delayMs;
    record.updatedAt = now;
    await this.#options.store.saveGoalContinuation(record);
    await this.#audit({
      conversationId: record.conversationId,
      eventType: "goal.continuation_scheduled",
      payload: {
        threadId: record.threadId,
        turnNumber: record.turnCount + 1,
        nextRunAt: record.nextRunAt,
        cooldownMs: delayMs,
      },
    });
    this.#options.onCooldown?.({
      conversationId: record.deliveryConversationId,
      turnNumber: record.turnCount + 1,
      goal,
      cooldownRemainingMs: delayMs,
    });
    const expectedNextRunAt = record.nextRunAt;
    const handle = this.#options.schedule(
      () => this.#fire(record.conversationId, expectedNextRunAt!).catch(async (error) => {
          const failedRecord = await this.#options.store
            .loadGoalContinuation(record.conversationId)
            .catch(() => undefined);
          if (failedRecord?.pending && failedRecord.nextRunAt === expectedNextRunAt) {
            failedRecord.pending = false;
            failedRecord.nextRunAt = null;
            failedRecord.enabled = false;
            failedRecord.updatedAt = this.#options.now();
            await this.#options.store.saveGoalContinuation(failedRecord).catch(() => undefined);
          }
          await this.#audit({
            conversationId: record.conversationId,
            eventType: "goal.continuation_timer_failed",
            payload: {
              threadId: record.threadId,
              errorType: error instanceof Error ? error.name : "Error",
            },
          });
          await this.#notify(
            record.deliveryConversationId,
            "Goal 自动续跑调度器发生异常，本次续跑未执行。请使用 /goal 查看状态；如需继续，可使用 /goal continue。",
          );
        }),
      delayMs,
    );
    this.#pendingTimers.set(record.conversationId, handle);
  }

  async #fire(conversationId: string, expectedNextRunAt: number): Promise<void> {
    this.#pendingTimers.delete(conversationId);
    if (!this.#started || this.#stopped) return;
    const record = await this.#options.store.loadGoalContinuation(conversationId);
    if (!record?.authorized || !record.enabled || !record.pending) return;
    if (record.nextRunAt !== expectedNextRunAt) return;
    if (this.#options.isConversationBusy(conversationId)) {
      record.pending = false;
      record.nextRunAt = null;
      record.updatedAt = this.#options.now();
      await this.#options.store.saveGoalContinuation(record);
      await this.#audit({
        conversationId,
        eventType: "goal.continuation_deferred",
        payload: { threadId: record.threadId, reason: "conversation-busy" },
      });
      await this.#scheduleNext(record);
      return;
    }
    const goal = await this.#getGoal(record);
    if (!goal || goal.status !== "active") {
      record.pending = false;
      record.nextRunAt = null;
      record.enabled = false;
      record.updatedAt = this.#options.now();
      await this.#options.store.saveGoalContinuation(record);
      await this.#audit({
        conversationId,
        eventType: "goal.continuation_reconciled_terminal_goal",
        payload: { threadId: record.threadId, goalStatus: goal?.status ?? "absent" },
      });
      return;
    }

    record.pending = false;
    record.nextRunAt = null;
    record.turnCount += 1;
    record.lastRunAt = this.#options.now();
    record.updatedAt = record.lastRunAt;
    await this.#options.store.saveGoalContinuation(record);
    await this.#audit({
      conversationId,
      eventType: "goal.continuation_started",
      payload: {
        threadId: record.threadId,
        turnNumber: record.turnCount,
        objective: goal.objective.slice(0, 200),
      },
    });

    const message = this.#continuationMessage(record, goal);
    const resolved: ResolvedGatewayIdentity = {
      userId: record.userId,
      role: record.role,
      conversationId: record.conversationId,
    };
    await this.#options.runContinuation({ record, goal, turnNumber: record.turnCount, message, resolved });
  }

  async #getGoal(record: GoalContinuationRecord): Promise<AgentGoal | undefined> {
    return await this.#agent.getGoal(record.threadId, { cwd: record.projectCwd });
  }

  async #budgetLimited(record: GoalContinuationRecord, goal: AgentGoal): Promise<void> {
    record.enabled = false;
    record.pending = false;
    record.nextRunAt = null;
    record.updatedAt = this.#options.now();
    await this.#cancelTimers(record.conversationId);
    await this.#options.store.saveGoalContinuation(record);
    await this.#agent.setGoal({
      threadId: record.threadId,
      cwd: record.projectCwd,
      status: "budgetLimited",
    });
    await this.#audit({
      conversationId: record.conversationId,
      eventType: "goal.continuation_budget_limited",
      payload: {
        threadId: record.threadId,
        tokensUsed: goal.tokensUsed,
        tokenBudget: goal.tokenBudget,
      },
    });
    await this.#notify(record.deliveryConversationId,
      "Goal 已达到 token 预算，自动续跑已停止（Goal 状态已置为 budgetLimited）。");
  }

  async #turnLimitReached(record: GoalContinuationRecord, goal: AgentGoal): Promise<void> {
    record.enabled = false;
    record.pending = false;
    record.nextRunAt = null;
    record.updatedAt = this.#options.now();
    await this.#cancelTimers(record.conversationId);
    await this.#options.store.saveGoalContinuation(record);
    await this.#audit({
      conversationId: record.conversationId,
      eventType: "goal.continuation_turn_limit",
      payload: { threadId: record.threadId, turnCount: record.turnCount },
    });
    await this.#notify(record.deliveryConversationId,
      `Goal 自动续跑已达到单会话轮次上限（${String(this.#options.maxTurns)} 轮），已停止。`);
  }

  async #wallTimeReached(record: GoalContinuationRecord, goal: AgentGoal): Promise<void> {
    record.enabled = false;
    record.pending = false;
    record.nextRunAt = null;
    record.updatedAt = this.#options.now();
    await this.#cancelTimers(record.conversationId);
    await this.#options.store.saveGoalContinuation(record);
    await this.#audit({
      conversationId: record.conversationId,
      eventType: "goal.continuation_wall_time_limit",
      payload: { threadId: record.threadId },
    });
    await this.#notify(record.deliveryConversationId,
      "Goal 自动续跑已达到最长时间限制，已停止。");
  }

  async #cancelPending(record: GoalContinuationRecord): Promise<void> {
    if (!record.pending && record.nextRunAt === null) return;
    record.pending = false;
    record.nextRunAt = null;
    await this.#cancelTimers(record.conversationId);
  }

  async #cancelTimers(conversationId: string): Promise<void> {
    const handle = this.#pendingTimers.get(conversationId);
    if (handle === undefined) return;
    this.#pendingTimers.delete(conversationId);
    this.#options.cancelSchedule(handle);
  }

  async #audit(event: AuditEventInput): Promise<void> {
    await this.#options.audit(event).catch(() => undefined);
  }

  async #notify(conversationId: string, text: string): Promise<void> {
    const send = this.#options.send;
    if (send) await send(conversationId, text).catch(() => undefined);
  }

  #continuationMessage(
    record: GoalContinuationRecord,
    goal: AgentGoal,
  ): IncomingMessage {
    return {
      id: `goal-continuation:${record.threadId}:${record.turnCount}:${this.#options.now()}`,
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
        "请继续推进上述目标，不要重复已完成的工作。",
        "Goal 是跨轮目标：完成当前一轮/阶段绝不等于整个 Goal 完成。",
        "只有当完整 objective 的全部阶段都已经完成时，才调用 floral_goal/update 把状态更新为 complete（FLORAL 会在回合结束后提交到原生 Goal）。",
        "不要输出 [GOAL_COMPLETE] 之类的标记。",
        "若需要更多信息，请明确说明还缺什么。",
        "如果目标只需要直接回答或总结，请直接完成，避免不必要的工具调用。",
      ].join("\n"),
      receivedAt: new Date(this.#options.now()),
    };
  }
}

function supportsGoalRuntime(
  agent: AgentRuntime,
): agent is AgentRuntime & AgentGoalRuntime {
  return typeof (agent as Partial<AgentGoalRuntime>).getGoal === "function"
    && typeof (agent as Partial<AgentGoalRuntime>).setGoal === "function";
}

function isRetryableError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return (error as { retryable?: unknown }).retryable === true;
}
