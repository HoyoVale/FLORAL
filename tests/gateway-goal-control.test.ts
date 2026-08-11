import { describe, expect, it } from "vitest";
import type {
  AgentGoal,
  AgentGoalRuntime,
  AgentRuntime,
  GoalContinuationRecord,
} from "../src/core/contracts.js";
import type { AgentRunRequest, AgentRunResult } from "../src/core/types.js";
import { GoalContinuationCoordinator } from "../src/service/goal-continuation-coordinator.js";
import { handleGoalControl } from "../src/service/gateway-goal-control.js";
import { MemoryThreadStore } from "../src/storage/memory-thread-store.js";

class GoalControlAgent implements AgentRuntime, AgentGoalRuntime {
  readonly name = "goal-control";
  goal: AgentGoal | undefined;
  async start(): Promise<void> {}
  async run(_request: AgentRunRequest): Promise<AgentRunResult> {
    return { threadId: "thread-1", finalText: "ok" };
  }
  async interrupt(): Promise<void> {}
  async stop(): Promise<void> {}
  async getGoal(): Promise<AgentGoal | undefined> { return this.goal; }
  async setGoal(input: Parameters<AgentGoalRuntime["setGoal"]>[0]): Promise<AgentGoal> {
    if (!this.goal) throw new Error("goal missing");
    this.goal = {
      ...this.goal,
      ...(input.objective !== undefined && input.objective !== null
        ? { objective: input.objective }
        : {}),
      ...(input.status !== undefined && input.status !== null ? { status: input.status } : {}),
      ...(input.tokenBudget !== undefined ? { tokenBudget: input.tokenBudget } : {}),
    };
    return this.goal;
  }
  async clearGoal(): Promise<boolean> { this.goal = undefined; return true; }
}

function goal(status: AgentGoal["status"]): AgentGoal {
  return {
    threadId: "thread-1",
    objective: "two rounds",
    status,
    tokenBudget: null,
    tokensUsed: 10,
    timeUsedSeconds: 5,
    createdAt: 1,
    updatedAt: 1,
  };
}

function record(turnCount: number): GoalContinuationRecord {
  return {
    conversationId: "conv-1",
    deliveryConversationId: "chat-1",
    userId: "owner-1",
    role: "owner",
    threadId: "thread-1",
    projectCwd: "/project",
    projectName: "project",
    authorized: true,
    enabled: false,
    pending: false,
    nextRunAt: null,
    turnCount,
    lastRunAt: 10,
    createdAt: 1,
    updatedAt: 10,
  };
}

async function harness(status: AgentGoal["status"], turnCount: number) {
  const agent = new GoalControlAgent();
  agent.goal = goal(status);
  const store = new MemoryThreadStore();
  await store.saveGoalContinuation(record(turnCount));
  const timers: unknown[] = [];
  const coordinator = new GoalContinuationCoordinator({
    agent,
    store,
    audit: async () => undefined,
    cooldownMs: 30,
    maxTurns: 0,
    maxWallTimeMs: 0,
    isConversationBusy: () => false,
    runContinuation: async () => undefined,
    schedule: (callback) => {
      timers.push(callback);
      return callback;
    },
    cancelSchedule: () => undefined,
  });
  await coordinator.start();
  const sent: string[] = [];
  const host = {
    agent,
    coordinator,
    audit: async () => undefined,
    send: async (_conversationId: string, text: string) => { sent.push(text); },
    isConversationBusy: () => false,
    resolveProjectContext: async () => ({
      threadId: "thread-1",
      projectName: "project",
      projectCwd: "/project",
    }),
    stopConversation: async () => undefined,
  };
  const resolved = { userId: "owner-1", role: "owner" as const, conversationId: "conv-1" };
  return { agent, store, coordinator, timers, sent, host, resolved };
}

describe("Goal status control", () => {
  it("restarts a completed Goal from continuation round 1", async () => {
    const h = await harness("complete", 3);
    const outcome = await handleGoalControl({
      host: h.host,
      resolved: h.resolved,
      deliveryConversationId: "chat-1",
      action: "restart",
      source: "status-card",
    });
    const saved = await h.store.loadGoalContinuation("conv-1");
    expect(outcome).toBe("restarted");
    expect(h.agent.goal?.status).toBe("active");
    expect(saved?.turnCount).toBe(0);
    expect(saved?.enabled).toBe(true);
    expect(saved?.pending).toBe(true);
    expect(h.timers).toHaveLength(1);
  });

  it("continues a paused Goal without resetting completed continuation rounds", async () => {
    const h = await harness("paused", 3);
    const outcome = await handleGoalControl({
      host: h.host,
      resolved: h.resolved,
      deliveryConversationId: "chat-1",
      action: "continue",
      source: "status-card",
    });
    const saved = await h.store.loadGoalContinuation("conv-1");
    expect(outcome).toBe("continued");
    expect(h.agent.goal?.status).toBe("active");
    expect(saved?.turnCount).toBe(3);
    expect(saved?.enabled).toBe(true);
    expect(saved?.pending).toBe(true);
  });
});
