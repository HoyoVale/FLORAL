import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  AgentRuntime,
  AgentGoalRuntime,
  AgentGoal,
  AgentGoalStatus,
  AgentThreadManagementRuntime,
  ChatTransport,
} from "../src/core/contracts.js";
import type {
  AgentRunRequest,
  AgentRunResult,
  IncomingMessage,
  OutgoingMessage,
} from "../src/core/types.js";
import { GatewayService } from "../src/service/gateway.js";
import { MemoryThreadStore } from "../src/storage/memory-thread-store.js";
import { ProjectWorkspaceRoot } from "../src/workspace/project-workspace.js";

class TestTransport implements ChatTransport {
  readonly name = "test";
  readonly sent: OutgoingMessage[] = [];
  #onMessage: ((message: IncomingMessage) => Promise<void>) | undefined;

  async start(onMessage: (message: IncomingMessage) => Promise<void>): Promise<void> {
    this.#onMessage = onMessage;
  }

  async send(message: OutgoingMessage): Promise<void> {
    this.sent.push(message);
  }

  async stop(): Promise<void> {}

  async emit(text: string, id: string): Promise<void> {
    if (!this.#onMessage) throw new Error("transport not started");
    await this.#onMessage({
      id,
      identity: {
        transport: "mock",
        botId: "bot",
        externalUserId: "owner",
        conversationId: "chat",
      },
      text,
      receivedAt: new Date(),
    });
  }
}

class ThreadAgent implements AgentRuntime, AgentThreadManagementRuntime, AgentGoalRuntime {
  readonly name = "thread-agent";
  readonly runs: AgentRunRequest[] = [];
  readonly listCwds: string[] = [];
  readonly goals = new Map<string, AgentGoal>();

  constructor(
    private readonly threadsByCwd: Map<string, Array<{ id: string; preview: string }>>,
  ) {}

  async start(): Promise<void> {}

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    this.runs.push(request);
    return {
      threadId: request.threadId ?? `new-thread-${this.runs.length}`,
      finalText: "done",
    };
  }

  async listThreads(input: { cwd: string; limit?: number }): Promise<Array<{ id: string; preview: string }>> {
    this.listCwds.push(input.cwd);
    return (this.threadsByCwd.get(input.cwd) ?? []).slice(0, input.limit ?? 20);
  }

  async archiveThread(): Promise<void> {}
  async getGoal(threadId: string): Promise<AgentGoal | undefined> {
    return this.goals.get(threadId);
  }
  async setGoal(input: {
    threadId: string;
    objective?: string | null;
    status?: AgentGoalStatus | null;
    tokenBudget?: number | null;
  }): Promise<AgentGoal> {
    const previous = this.goals.get(input.threadId);
    const goal: AgentGoal = {
      threadId: input.threadId,
      objective: input.objective ?? previous?.objective ?? "",
      status: input.status ?? previous?.status ?? "active",
      tokenBudget: input.tokenBudget !== undefined
        ? input.tokenBudget
        : previous?.tokenBudget ?? null,
      tokensUsed: previous?.tokensUsed ?? 0,
      timeUsedSeconds: previous?.timeUsedSeconds ?? 0,
      createdAt: previous?.createdAt ?? 100,
      updatedAt: 200,
    };
    this.goals.set(input.threadId, goal);
    return goal;
  }
  async clearGoal(threadId: string): Promise<boolean> {
    return this.goals.delete(threadId);
  }
  async interrupt(): Promise<void> {}
  async stop(): Promise<void> {}
}

describe("Gateway project/chat routing", () => {
  it("maps direct-child projects to cwd-scoped Codex thread state without exposing thread ids", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-gateway-workspace-"));
    const floralDir = join(root, "FLORAL");
    const wisteriaDir = join(root, "WISTERIA");
    await mkdir(floralDir);
    await mkdir(wisteriaDir);
    const floral = await realpath(floralDir);
    const wisteria = await realpath(wisteriaDir);

    const transport = new TestTransport();
    const store = new MemoryThreadStore();
    const agent = new ThreadAgent(new Map([
      [floral, [
        { id: "thr-floral-one", preview: "FLORAL first chat" },
        { id: "thr-floral-two", preview: "FLORAL second chat" },
      ]],
      [wisteria, [
        { id: "thr-wisteria-one", preview: "WISTERIA physics" },
      ]],
    ]));
    const workspace = new ProjectWorkspaceRoot(root);
    const gateway = new GatewayService(transport, agent, store, {
      cwd: floral,
      workspace,
      trustMockOwner: true,
    });

    try {
      await gateway.start();

      await transport.emit("/projects", "m1");
      expect(transport.sent.at(-1)?.text).toContain("FLORAL ← 当前");
      expect(transport.sent.at(-1)?.text).toContain("WISTERIA");

      await transport.emit("/chats", "m2");
      const chatList = transport.sent.at(-1)?.text ?? "";
      expect(chatList).toContain("1. FLORAL first chat");
      expect(chatList).toContain("2. FLORAL second chat");
      expect(chatList).not.toContain("thr-floral-one");
      expect(chatList).not.toContain("thr-floral-two");
      expect(agent.listCwds.at(-1)).toBe(floral);

      await transport.emit("/chat 2", "m3");
      expect(transport.sent.at(-1)?.text).toContain("FLORAL second chat");

      await transport.emit("/goal set --tokens 5000 Finish FLORAL hardening", "m3-goal");
      expect(transport.sent.at(-1)?.text).toContain("状态：active");
      expect(transport.sent.at(-1)?.text).toContain("Token：0 / 5000");
      await transport.emit("/goal complete", "m3-goal-complete");
      expect(transport.sent.at(-1)?.text).toContain("状态：complete");
      await transport.emit("/goal clear", "m3-goal-clear");
      expect(transport.sent.at(-1)?.text).toContain("已清除");

      await transport.emit("inspect floral", "m4");
      expect(agent.runs.at(-1)).toMatchObject({
        cwd: floral,
        threadId: "thr-floral-two",
      });

      await transport.emit("/project WISTERIA", "m5");
      expect(transport.sent.at(-1)?.text).toContain("WISTERIA");
      await transport.emit("/chat new", "m6");
      await transport.emit("inspect wisteria", "m7");
      expect(agent.runs.at(-1)?.cwd).toBe(wisteria);
      expect(agent.runs.at(-1)?.threadId).toBeUndefined();

      await transport.emit("/project FLORAL", "m8");
      await transport.emit("continue floral", "m9");
      expect(agent.runs.at(-1)).toMatchObject({
        cwd: floral,
        threadId: "thr-floral-two",
      });

      await transport.emit("/status --debug", "m10");
      const status = transport.sent.at(-1)?.text ?? "";
      expect(status).toContain("workspace=enabled");
      expect(status).toContain("project=FLORAL");
      expect(status).not.toContain(root);
      expect(status).not.toContain("thr-floral-two");
    } finally {
      await gateway.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("consumes the legacy single-project thread pointer once so /chat new stays new", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-legacy-project-"));
    const floralDir = join(root, "FLORAL");
    await mkdir(floralDir);
    const floral = await realpath(floralDir);
    const transport = new TestTransport();
    const store = new MemoryThreadStore();
    const owner = await store.claimOwner({
      transport: "mock",
      botId: "bot",
      externalUserId: "owner",
      conversationId: "chat",
    });
    await store.setActiveThread(owner.conversationId, "legacy-thread");
    const agent = new ThreadAgent(new Map());
    const gateway = new GatewayService(transport, agent, store, {
      cwd: floral,
      workspace: new ProjectWorkspaceRoot(root),
    });

    try {
      await gateway.start();
      await transport.emit("/project FLORAL", "m1");
      expect(await store.getProjectActiveThread(
        owner.conversationId,
        "FLORAL",
      )).toBe("legacy-thread");
      expect(await store.getActiveThread(owner.conversationId)).toBeUndefined();

      await transport.emit("/chat new", "m2");
      await transport.emit("fresh work", "m3");
      expect(agent.runs.at(-1)?.threadId).toBeUndefined();
      expect(agent.runs.at(-1)?.cwd).toBe(floral);
    } finally {
      await gateway.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires a fresh /chats list before selecting by number", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-chat-cache-"));
    const floralDir = join(root, "FLORAL");
    await mkdir(floralDir);
    const floral = await realpath(floralDir);
    const transport = new TestTransport();
    const store = new MemoryThreadStore();
    const agent = new ThreadAgent(new Map([
      [floral, [{ id: "thr-hidden", preview: "Hidden id chat" }]],
    ]));
    const gateway = new GatewayService(transport, agent, store, {
      cwd: floral,
      workspace: new ProjectWorkspaceRoot(root),
      trustMockOwner: true,
    });

    try {
      await gateway.start();
      await transport.emit("/chat 1", "m1");
      expect(transport.sent.at(-1)?.text).toContain("请先重新使用 /chats");
      expect(agent.runs).toHaveLength(0);
    } finally {
      await gateway.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});
