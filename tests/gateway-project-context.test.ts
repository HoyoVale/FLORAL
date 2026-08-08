import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  AgentRuntime,
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

class NoopAgent implements AgentRuntime {
  readonly name = "noop";
  async start(): Promise<void> {}
  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    return {
      threadId: request.threadId ?? "thread-new",
      finalText: "done",
    };
  }
  async interrupt(): Promise<void> {}
  async stop(): Promise<void> {}
}

describe("Gateway project shared context control", () => {
  it("reports status and lets the owner initialize an existing project's context without replacing AGENTS", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-gateway-context-"));
    const projectDir = join(root, "FLORAL");
    await mkdir(projectDir);
    await writeFile(
      join(projectDir, "AGENTS.md"),
      "# Existing FLORAL rules\n\n- Preserve this line.\n",
    );

    const transport = new TestTransport();
    const store = new RoleWorkspaceStore("owner");
    store.selected.set("conversation-1", "FLORAL");
    store.projectThreads.set("conversation-1\u0000FLORAL", "existing-thread");
    const gateway = new GatewayService(
      transport,
      new NoopAgent(),
      store,
      {
        cwd: projectDir,
        workspace: new ProjectWorkspaceRoot(root),
      },
    );

    try {
      await gateway.start();

      await transport.emit("/project context", "m1");
      expect(transport.sent.at(-1)?.text).toContain("state=not-ready");
      expect(transport.sent.at(-1)?.text).not.toContain("\\n");

      await transport.emit("/project context init", "m2");
      const initialized = transport.sent.at(-1)?.text ?? "";
      expect(initialized).toContain("共享上下文已初始化");
      expect(initialized).toContain("instruction=AGENTS.md");
      expect(initialized).toContain("instruction_link=linked");
      expect(initialized).toContain("/chat new");

      const agents = await readFile(join(projectDir, "AGENTS.md"), "utf8");
      expect(agents).toContain("- Preserve this line.");
      expect(agents).toContain("FLORAL:PROJECT-CONTEXT:BEGIN");
      expect(store.audits).toContainEqual(expect.objectContaining({
        eventType: "command.project_context_initialized",
        payload: expect.objectContaining({
          projectName: "FLORAL",
          changed: true,
        }),
      }));

      await transport.emit("/project context status", "m3");
      expect(transport.sent.at(-1)?.text).toContain("state=ready");
    } finally {
      await gateway.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("denies context initialization to a non-owner without creating files", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-gateway-context-denied-"));
    const projectDir = join(root, "FLORAL");
    await mkdir(projectDir);

    const transport = new TestTransport();
    const store = new RoleWorkspaceStore("operator");
    store.selected.set("conversation-1", "FLORAL");
    const gateway = new GatewayService(
      transport,
      new NoopAgent(),
      store,
      {
        cwd: projectDir,
        workspace: new ProjectWorkspaceRoot(root),
      },
    );

    try {
      await gateway.start();
      await transport.emit("/project context init", "m1");
      expect(transport.sent.at(-1)?.text).toContain("只有 owner");
      await expect(readFile(join(projectDir, "AGENTS.md"), "utf8"))
        .rejects.toThrow();
    } finally {
      await gateway.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});
