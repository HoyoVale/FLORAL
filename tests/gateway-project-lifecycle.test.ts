import { lstat, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  AgentRuntime,
  AgentThreadManagementRuntime,
  ChatTransport,
  GatewayStore,
  WorkspaceStateStore,
} from "../src/core/contracts.js";
import type {
  AgentRunRequest,
  AgentRunResult,
  AuditEventInput,
  ExternalIdentity,
  IncomingMessage,
  OutgoingMessage,
  ResolvedGatewayIdentity,
  TransportKind,
} from "../src/core/types.js";
import { GatewayService } from "../src/service/gateway.js";
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
        externalUserId: "user",
        conversationId: "chat",
      },
      text,
      receivedAt: new Date(),
    });
  }
}

class RoleWorkspaceStore implements GatewayStore, WorkspaceStateStore {
  readonly audits: AuditEventInput[] = [];
  readonly selected = new Map<string, string>();
  readonly projectThreads = new Map<string, string>();
  readonly accepted = new Set<string>();

  constructor(readonly role: ResolvedGatewayIdentity["role"]) {}

  async resolveIdentity(_identity: ExternalIdentity): Promise<ResolvedGatewayIdentity> {
    return {
      userId: "user-1",
      role: this.role,
      conversationId: "conversation-1",
    };
  }

  async claimOwner(_identity: ExternalIdentity): Promise<ResolvedGatewayIdentity> {
    return {
      userId: "user-1",
      role: "owner",
      conversationId: "conversation-1",
    };
  }

  async hasOwner(_transport: TransportKind, _botId: string): Promise<boolean> {
    return true;
  }

  async acceptMessage(_identity: ExternalIdentity, messageId: string): Promise<boolean> {
    if (this.accepted.has(messageId)) return false;
    this.accepted.add(messageId);
    return true;
  }

  async getActiveThread(): Promise<string | undefined> {
    return undefined;
  }
  async setActiveThread(): Promise<void> {}
  async clearActiveThread(): Promise<void> {}

  async getSelectedProject(conversationId: string): Promise<string | undefined> {
    return this.selected.get(conversationId);
  }

  async setSelectedProject(conversationId: string, projectName: string): Promise<void> {
    this.selected.set(conversationId, projectName);
  }

  async getProjectActiveThread(
    conversationId: string,
    projectName: string,
  ): Promise<string | undefined> {
    return this.projectThreads.get(`${conversationId}\u0000${projectName}`);
  }

  async setProjectActiveThread(
    conversationId: string,
    projectName: string,
    threadId: string,
  ): Promise<void> {
    this.projectThreads.set(`${conversationId}\u0000${projectName}`, threadId);
  }

  async clearProjectActiveThread(
    conversationId: string,
    projectName: string,
  ): Promise<void> {
    this.projectThreads.delete(`${conversationId}\u0000${projectName}`);
  }

  async appendAudit(event: AuditEventInput): Promise<void> {
    this.audits.push(structuredClone(event));
  }

  async close(): Promise<void> {}
}

class LifecycleAgent implements AgentRuntime, AgentThreadManagementRuntime {
  readonly name = "lifecycle-agent";
  readonly runs: AgentRunRequest[] = [];
  readonly archives: string[] = [];

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
    return (this.threadsByCwd.get(input.cwd) ?? []).slice(0, input.limit ?? 20);
  }

  async archiveThread(threadId: string): Promise<void> {
    this.archives.push(threadId);
    for (const [cwd, entries] of this.threadsByCwd) {
      this.threadsByCwd.set(cwd, entries.filter((entry) => entry.id !== threadId));
    }
  }

  async interrupt(): Promise<void> {}
  async stop(): Promise<void> {}
}

describe("Gateway project/chat lifecycle", () => {
  it("lets only the owner create a new direct-child project and selects it", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-project-create-"));
    const transport = new TestTransport();
    const store = new RoleWorkspaceStore("owner");
    const agent = new LifecycleAgent(new Map());
    const gateway = new GatewayService(transport, agent, store, {
      cwd: root,
      workspace: new ProjectWorkspaceRoot(root),
    });

    try {
      await gateway.start();
      await transport.emit("/project new NewProject", "m1");
      expect(transport.sent.at(-1)?.text).toContain("已创建并切换到项目：NewProject");
      expect((await lstat(join(root, "NewProject"))).isDirectory()).toBe(true);
      expect(await readFile(join(root, "NewProject", "AGENTS.md"), "utf8"))
        .toContain("FLORAL:PROJECT-CONTEXT:BEGIN");
      expect(await readFile(
        join(root, "NewProject", ".floral", "CONTEXT.md"),
        "utf8",
      )).toContain("Project: NewProject");
      expect(store.selected.get("conversation-1")).toBe("NewProject");

      await transport.emit("hello project", "m2");
      expect(agent.runs).toHaveLength(1);
      expect(agent.runs[0]?.cwd).toBe(await realpath(join(root, "NewProject")));
      expect(agent.runs[0]?.threadId).toBeUndefined();
      expect(await lstat(join(root, "NewProject", "artifacts")).catch(() => undefined))
        .toBeUndefined();
      expect(store.audits).toContainEqual(expect.objectContaining({
        eventType: "command.project_created",
        payload: { projectName: "NewProject" },
      }));
    } finally {
      await gateway.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("denies project creation to a non-owner without touching the filesystem", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-project-create-denied-"));
    const transport = new TestTransport();
    const store = new RoleWorkspaceStore("operator");
    const agent = new LifecycleAgent(new Map());
    const gateway = new GatewayService(transport, agent, store, {
      cwd: root,
      workspace: new ProjectWorkspaceRoot(root),
    });

    try {
      await gateway.start();
      await transport.emit("/project new Forbidden", "m1");
      expect(transport.sent.at(-1)?.text).toContain("只有 owner 可以创建项目");
      expect(await lstat(join(root, "Forbidden")).catch(() => undefined)).toBeUndefined();
      expect(store.audits).toContainEqual(expect.objectContaining({
        eventType: "command.project_create_denied",
        payload: { reason: "owner-required" },
      }));
    } finally {
      await gateway.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("archives a cached opaque Codex thread and clears the active pointer when needed", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-chat-archive-"));
    const projectDir = join(root, "FLORAL");
    await mkdir(projectDir);
    const project = await realpath(projectDir);
    const transport = new TestTransport();
    const store = new RoleWorkspaceStore("owner");
    store.selected.set("conversation-1", "FLORAL");
    store.projectThreads.set("conversation-1\u0000FLORAL", "thr-two");
    const agent = new LifecycleAgent(new Map([
      [project, [
        { id: "thr-one", preview: "First chat" },
        { id: "thr-two", preview: "Second chat" },
      ]],
    ]));
    const gateway = new GatewayService(transport, agent, store, {
      cwd: project,
      workspace: new ProjectWorkspaceRoot(root),
    });

    try {
      await gateway.start();
      await transport.emit("/chats", "m1");
      expect(transport.sent.at(-1)?.text).toContain("2. Second chat ← 当前");

      await transport.emit("/chat archive 2", "m2");
      const archived = transport.sent.at(-1)?.text ?? "";
      expect(archived).toContain("已归档会话：Second chat");
      expect(archived).not.toContain("thr-two");
      expect(agent.archives).toEqual(["thr-two"]);
      expect(await store.getProjectActiveThread("conversation-1", "FLORAL"))
        .toBeUndefined();
      expect(store.audits).toContainEqual(expect.objectContaining({
        eventType: "command.chat_archived",
        payload: {
          projectName: "FLORAL",
          listIndex: 2,
          wasActive: true,
        },
      }));

      await transport.emit("/chats", "m3");
      const refreshed = transport.sent.at(-1)?.text ?? "";
      expect(refreshed).toContain("1. First chat");
      expect(refreshed).not.toContain("Second chat");
    } finally {
      await gateway.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("denies thread archive to a non-owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-chat-archive-denied-"));
    const projectDir = join(root, "FLORAL");
    await mkdir(projectDir);
    const project = await realpath(projectDir);
    const transport = new TestTransport();
    const store = new RoleWorkspaceStore("operator");
    store.selected.set("conversation-1", "FLORAL");
    const agent = new LifecycleAgent(new Map([
      [project, [{ id: "thr-one", preview: "First chat" }]],
    ]));
    const gateway = new GatewayService(transport, agent, store, {
      cwd: project,
      workspace: new ProjectWorkspaceRoot(root),
    });

    try {
      await gateway.start();
      await transport.emit("/chats", "m1");
      await transport.emit("/chat archive 1", "m2");
      expect(transport.sent.at(-1)?.text).toContain("只有 owner 可以归档 Codex 会话");
      expect(agent.archives).toEqual([]);
    } finally {
      await gateway.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});
