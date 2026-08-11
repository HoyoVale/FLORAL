import { describe, expect, it } from "vitest";
import type {
  AgentGoal,
  AgentGoalRuntime,
  AgentRuntime,
} from "../src/core/contracts.js";
import type { AgentRunRequest, AgentRunResult } from "../src/core/types.js";
import { GoalStatusFacade } from "../src/service/gateway-goal-continuation.js";
import { handleGoalControl } from "../src/service/gateway-goal-control.js";

class FakeGoalAgent implements AgentRuntime, AgentGoalRuntime {
  readonly name = "fake";
  goal: AgentGoal | undefined = {
    threadId: "t",
    objective: "o",
    status: "paused",
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 1,
    updatedAt: 1,
  };

  async start(): Promise<void> {}
  async run(_request: AgentRunRequest): Promise<AgentRunResult> {
    return { threadId: "t", finalText: "ok" };
  }
  async interrupt(): Promise<void> {}
  async stop(): Promise<void> {}

  async getGoal(): Promise<AgentGoal | undefined> {
    return this.goal;
  }

  async setGoal(
    input: Parameters<AgentGoalRuntime["setGoal"]>[0],
  ): Promise<AgentGoal> {
    if (!this.goal) throw new Error("missing");
    this.goal = {
      ...this.goal,
      ...(input.status !== undefined && input.status !== null
        ? { status: input.status }
        : {}),
    };
    return this.goal;
  }

  async clearGoal(): Promise<boolean> {
    this.goal = undefined;
    return true;
  }
}

function host(agent: FakeGoalAgent) {
  return {
    agent,
    audit: async () => undefined,
    send: async () => undefined,
    isConversationBusy: () => false,
    resolveProjectContext: async () => ({
      threadId: "t",
      projectName: "p",
      projectCwd: "/p",
    }),
    stopConversation: async () => undefined,
  };
}

const owner = { userId: "u", role: "owner" as const, conversationId: "c" };

describe("Goal status control (no continuation)", () => {
  it("continues a paused goal by setting it active", async () => {
    const agent = new FakeGoalAgent();
    const outcome = await handleGoalControl({
      host: host(agent),
      resolved: owner,
      deliveryConversationId: "chat-1",
      action: "continue",
      source: "status-card",
    });
    expect(outcome).toBe("continued");
    expect(agent.goal?.status).toBe("active");
  });

  it("restarts a completed goal by setting it active", async () => {
    const agent = new FakeGoalAgent();
    agent.goal = { ...agent.goal!, status: "complete" };
    const outcome = await handleGoalControl({
      host: host(agent),
      resolved: owner,
      deliveryConversationId: "chat-1",
      action: "restart",
      source: "status-card",
    });
    expect(outcome).toBe("restarted");
    expect(agent.goal?.status).toBe("active");
  });

  it("denies non-owner control", async () => {
    const agent = new FakeGoalAgent();
    const outcome = await handleGoalControl({
      host: host(agent),
      resolved: { userId: "u", role: "operator", conversationId: "c" },
      deliveryConversationId: "chat-1",
      action: "stop",
      source: "status-card",
    });
    expect(outcome).toBe("ignored");
    expect(agent.goal?.status).toBe("paused");
  });

  it("pauses the native goal and stops the conversation", async () => {
    const agent = new FakeGoalAgent();
    let stopped = false;
    const outcome = await handleGoalControl({
      host: {
        ...host(agent),
        stopConversation: async () => {
          stopped = true;
        },
      },
      resolved: owner,
      deliveryConversationId: "chat-1",
      action: "pause",
      source: "status-card",
    });
    expect(outcome).toBe("paused");
    expect(agent.goal?.status).toBe("paused");
    expect(stopped).toBe(true);
  });
});

describe("GoalStatusFacade", () => {
  it("builds a status snapshot from the native goal", async () => {
    const agent = new FakeGoalAgent();
    const facade = new GoalStatusFacade({
      agent,
      transport: {
        name: "test",
        start: async () => undefined,
        send: async () => undefined,
        stop: async () => undefined,
      },
      audit: async () => undefined,
      send: async () => undefined,
      isConversationBusy: () => false,
      resolveProjectContext: host(agent).resolveProjectContext,
      stopConversation: async () => undefined,
      statusCard: { enabled: false, updateIntervalMs: 5_000, autoPin: true },
    });
    const snapshot = await facade.statusSnapshot("c", "chat-1", "idle");
    expect(snapshot.goal?.status).toBe("paused");
    expect(snapshot.projectName).toBe("p");
  });
});
