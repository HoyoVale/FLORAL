import { describe, expect, it } from "vitest";
import type {
  AgentGoal,
  AgentGoalRuntime,
  AgentRuntime,
} from "../src/core/contracts.js";
import type {
  AgentRunRequest,
  AgentRunResult,
  AuditEventInput,
} from "../src/core/types.js";
import { GoalContinuationCoordinator } from "../src/service/goal-continuation-coordinator.js";
import { MemoryThreadStore } from "../src/storage/memory-thread-store.js";

class FakeGoalAgent implements AgentRuntime, AgentGoalRuntime {
  readonly name = "fake-goal";
  goal: AgentGoal | undefined;
  runCount = 0;
  setGoalInputs: Array<{ status?: string; tokenBudget?: number | null }> = [];

  async start(): Promise<void> {}
  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    this.runCount += 1;
    return { threadId: "thread-1", finalText: `run-${String(this.runCount)}` };
  }
  async interrupt(): Promise<void> {}
  async stop(): Promise<void> {}

  async getGoal(threadId: string): Promise<AgentGoal | undefined> {
    return this.goal && this.goal.threadId === threadId ? this.goal : undefined;
  }

  async setGoal(input: {
    threadId: string;
    cwd?: string | undefined;
    objective?: string | null | undefined;
    status?: AgentGoal["status"] | null | undefined;
    tokenBudget?: number | null | undefined;
  }): Promise<AgentGoal> {
    this.setGoalInputs.push({
      ...(input.status ? { status: input.status } : {}),
      ...(input.tokenBudget !== undefined ? { tokenBudget: input.tokenBudget } : {}),
    });
    this.goal = {
      threadId: input.threadId,
      objective: input.objective ?? this.goal?.objective ?? "objective",
      status: input.status ?? this.goal?.status ?? "active",
      tokenBudget: input.tokenBudget !== undefined
        ? input.tokenBudget
        : this.goal?.tokenBudget ?? null,
      tokensUsed: this.goal?.tokensUsed ?? 0,
      timeUsedSeconds: this.goal?.timeUsedSeconds ?? 0,
      createdAt: this.goal?.createdAt ?? 1,
      updatedAt: this.goal?.updatedAt ?? 1,
    };
    return this.goal;
  }

  async clearGoal(): Promise<boolean> {
    this.goal = undefined;
    return true;
  }
}

function makeGoal(
  threadId: string,
  status: AgentGoal["status"],
  tokenBudget: number | null = null,
  tokensUsed = 0,
): AgentGoal {
  return {
    threadId,
    objective: "test goal",
    status,
    tokenBudget,
    tokensUsed,
    timeUsedSeconds: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

function harness(input: {
  cooldownMs?: number;
  maxTurns?: number;
  maxWallTimeMs?: number;
} = {}) {
  let now = 1_000;
  const timers: Array<{ at: number; fn: () => void; handle: number }> = [];
  const canceled = new Set<number>();
  const audits: AuditEventInput[] = [];
  const agent = new FakeGoalAgent();
  const store = new MemoryThreadStore();
  let nextHandle = 1;
  const coordinator = new GoalContinuationCoordinator({
    agent,
    store,
    audit: async (event) => {
      audits.push(event);
    },
    send: async () => undefined,
    cooldownMs: input.cooldownMs ?? 30,
    maxTurns: input.maxTurns ?? 0,
    maxWallTimeMs: input.maxWallTimeMs ?? 0,
    isConversationBusy: () => false,
    runContinuation: async (run) => {
      await agent.run({ text: "continue", cwd: run.record.projectCwd });
    },
    now: () => now,
    schedule: (fn, delay) => {
      const handle = nextHandle;
      nextHandle += 1;
      timers.push({
        at: now + delay,
        fn: async () => {
          await fn();
        },
        handle,
      });
      return handle;
    },
    cancelSchedule: (handle) => {
      canceled.add(handle as number);
    },
  });
  return {
    agent,
    store,
    coordinator,
    audits,
    timers,
    canceled,
    async advance(ms: number): Promise<void> {
      now += ms;
      const due = timers.splice(0).filter((timer) =>
        timer.at <= now && !canceled.has(timer.handle));
      for (const timer of due) await timer.fn();
    },
    nowValue(): number {
      return now;
    },
  };
}

const authorizeInput = {
  conversationId: "conv-1",
  deliveryConversationId: "chat-1",
  userId: "user-1",
  threadId: "thread-1",
  projectCwd: "/project",
  projectName: "project",
};

describe("GoalContinuationCoordinator", () => {
  it("schedules and fires one continuation after a completed run", async () => {
    const h = harness();
    await h.coordinator.start();
    await h.coordinator.authorize({ ...authorizeInput, enable: true });
    h.agent.goal = makeGoal("thread-1", "active");

    await h.coordinator.onRunCompleted({
      conversationId: "conv-1",
      deliveryConversationId: "chat-1",
      threadId: "thread-1",
      projectCwd: "/project",
      projectName: "project",
    });
    expect(h.timers).toHaveLength(1);
    expect(h.agent.runCount).toBe(0);

    await h.advance(30);
    expect(h.agent.runCount).toBe(1);
    expect(h.audits.some((event) => event.eventType === "goal.continuation_started"))
      .toBe(true);
    const record = await h.store.loadGoalContinuation("conv-1");
    expect(record?.turnCount).toBe(1);
    expect(record?.pending).toBe(false);
  });

  it("keeps scheduling while the goal stays active", async () => {
    const h = harness();
    await h.coordinator.start();
    await h.coordinator.authorize({ ...authorizeInput, enable: true });
    h.agent.goal = makeGoal("thread-1", "active");

    for (let round = 0; round < 3; round += 1) {
      await h.coordinator.onRunCompleted({
        conversationId: "conv-1",
        deliveryConversationId: "chat-1",
        threadId: "thread-1",
        projectCwd: "/project",
        projectName: "project",
      });
      expect(h.timers).toHaveLength(1);
      await h.advance(30);
    }
    expect(h.agent.runCount).toBe(3);
    expect((await h.store.loadGoalContinuation("conv-1"))?.turnCount).toBe(3);
  });

  it("lets a user message supersede a pending continuation", async () => {
    const h = harness();
    await h.coordinator.start();
    await h.coordinator.authorize({ ...authorizeInput, enable: true });
    h.agent.goal = makeGoal("thread-1", "active");

    await h.coordinator.onRunCompleted({
      conversationId: "conv-1",
      deliveryConversationId: "chat-1",
      threadId: "thread-1",
      projectCwd: "/project",
      projectName: "project",
    });
    expect(h.timers).toHaveLength(1);
    await h.coordinator.onUserMessage("conv-1");
    expect(h.canceled.size).toBe(1);
    expect((await h.store.loadGoalContinuation("conv-1"))?.pending).toBe(false);
    await h.advance(60);
    expect(h.agent.runCount).toBe(0);
    expect(h.audits.some((event) => event.eventType === "goal.continuation_superseded"))
      .toBe(true);
  });

  it("stops continuation on /stop and disables the loop", async () => {
    const h = harness();
    await h.coordinator.start();
    await h.coordinator.authorize({ ...authorizeInput, enable: true });
    h.agent.goal = makeGoal("thread-1", "active");

    await h.coordinator.onRunCompleted({
      conversationId: "conv-1",
      deliveryConversationId: "chat-1",
      threadId: "thread-1",
      projectCwd: "/project",
      projectName: "project",
    });
    const stopped = await h.coordinator.stopContinuation("conv-1", "stop-command");
    expect(stopped).toBe(true);
    const record = await h.store.loadGoalContinuation("conv-1");
    expect(record?.enabled).toBe(false);
    expect(record?.pending).toBe(false);
    await h.advance(60);
    expect(h.agent.runCount).toBe(0);
  });

  it("marks the native goal budgetLimited when its token budget is exhausted", async () => {
    const h = harness();
    await h.coordinator.start();
    await h.coordinator.authorize({ ...authorizeInput, enable: true });
    h.agent.goal = makeGoal("thread-1", "active", 10, 10);

    await h.coordinator.onRunCompleted({
      conversationId: "conv-1",
      deliveryConversationId: "chat-1",
      threadId: "thread-1",
      projectCwd: "/project",
      projectName: "project",
    });
    expect(h.timers).toHaveLength(0);
    expect(h.agent.setGoalInputs.some((input) => input.status === "budgetLimited"))
      .toBe(true);
    expect((await h.store.loadGoalContinuation("conv-1"))?.enabled).toBe(false);
    expect(h.audits.some((event) => event.eventType === "goal.continuation_budget_limited"))
      .toBe(true);
  });

  it("stops after the configured maximum turn count", async () => {
    const h = harness({ maxTurns: 2 });
    await h.coordinator.start();
    await h.coordinator.authorize({ ...authorizeInput, enable: true });
    h.agent.goal = makeGoal("thread-1", "active");

    await h.coordinator.onRunCompleted({
      conversationId: "conv-1",
      deliveryConversationId: "chat-1",
      threadId: "thread-1",
      projectCwd: "/project",
      projectName: "project",
    });
    await h.advance(30);
    expect(h.agent.runCount).toBe(1);
    await h.coordinator.onRunCompleted({
      conversationId: "conv-1",
      deliveryConversationId: "chat-1",
      threadId: "thread-1",
      projectCwd: "/project",
      projectName: "project",
    });
    expect(h.timers).toHaveLength(1);
    await h.advance(30);
    expect(h.agent.runCount).toBe(2);
    await h.coordinator.onRunCompleted({
      conversationId: "conv-1",
      deliveryConversationId: "chat-1",
      threadId: "thread-1",
      projectCwd: "/project",
      projectName: "project",
    });
    expect(h.timers).toHaveLength(0);
    expect((await h.store.loadGoalContinuation("conv-1"))?.enabled).toBe(false);
    expect(h.audits.some((event) => event.eventType === "goal.continuation_turn_limit"))
      .toBe(true);
  });

  it("quarantines pending continuations on service restart", async () => {
    const h = harness();
    await h.coordinator.start();
    await h.coordinator.authorize({ ...authorizeInput, enable: true });
    h.agent.goal = makeGoal("thread-1", "active");
    await h.coordinator.onRunCompleted({
      conversationId: "conv-1",
      deliveryConversationId: "chat-1",
      threadId: "thread-1",
      projectCwd: "/project",
      projectName: "project",
    });
    expect((await h.store.loadGoalContinuation("conv-1"))?.pending).toBe(true);

    const restarted = new GoalContinuationCoordinator({
      agent: h.agent,
      store: h.store,
      audit: async (event) => {
        h.audits.push(event);
      },
      cooldownMs: 30,
      maxTurns: 0,
      maxWallTimeMs: 0,
      isConversationBusy: () => false,
      runContinuation: async () => undefined,
      now: () => h.nowValue(),
      schedule: (fn) => {
        fn();
        return 1;
      },
      cancelSchedule: () => undefined,
    });
    await restarted.start();
    const record = await h.store.loadGoalContinuation("conv-1");
    expect(record?.pending).toBe(false);
    expect(h.audits.some((event) => event.eventType === "goal.continuation_quarantined"))
      .toBe(true);
  });

  it("disables continuation when a run fails", async () => {
    const h = harness();
    await h.coordinator.start();
    await h.coordinator.authorize({ ...authorizeInput, enable: true });
    h.agent.goal = makeGoal("thread-1", "active");
    await h.coordinator.onRunCompleted({
      conversationId: "conv-1",
      deliveryConversationId: "chat-1",
      threadId: "thread-1",
      projectCwd: "/project",
      projectName: "project",
    });
    await h.coordinator.onRunFailed("conv-1", new Error("boom"));
    const record = await h.store.loadGoalContinuation("conv-1");
    expect(record?.enabled).toBe(false);
    expect(h.audits.some((event) => event.eventType === "goal.continuation_stopped"))
      .toBe(true);
  });
});
