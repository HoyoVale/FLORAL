import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
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
import { bootstrapProjectContext } from "../src/workspace/project-context.js";

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

class RoleStore implements GatewayStore, WorkspaceStateStore {
  readonly audits: AuditEventInput[] = [];
  readonly selected = new Map<string, string>();
  readonly projectThreads = new Map<string, string>();
  readonly accepted = new Set<string>();

  constructor(readonly role: ResolvedGatewayIdentity["role"]) {}

  async resolveIdentity(_identity: ExternalIdentity): Promise<ResolvedGatewayIdentity> {
    return { userId: "user-1", role: this.role, conversationId: "conversation-1" };
  }
  async claimOwner(_identity: ExternalIdentity): Promise<ResolvedGatewayIdentity> {
    return { userId: "user-1", role: "owner", conversationId: "conversation-1" };
  }
  async hasOwner(_transport: TransportKind, _botId: string): Promise<boolean> {
    return true;
  }
  async acceptMessage(_identity: ExternalIdentity, messageId: string): Promise<boolean> {
    if (this.accepted.has(messageId)) return false;
    this.accepted.add(messageId);
    return true;
  }
  async getActiveThread(): Promise<string | undefined> { return undefined; }
  async setActiveThread(): Promise<void> {}
  async clearActiveThread(): Promise<void> {}
  async getSelectedProject(conversationId: string): Promise<string | undefined> {
    return this.selected.get(conversationId);
  }
  async setSelectedProject(conversationId: string, projectName: string): Promise<void> {
    this.selected.set(conversationId, projectName);
  }
  async getProjectActiveThread(conversationId: string, projectName: string): Promise<string | undefined> {
    return this.projectThreads.get(`${conversationId}\u0000${projectName}`);
  }
  async setProjectActiveThread(conversationId: string, projectName: string, threadId: string): Promise<void> {
    this.projectThreads.set(`${conversationId}\u0000${projectName}`, threadId);
  }
  async clearProjectActiveThread(conversationId: string, projectName: string): Promise<void> {
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
    return { threadId: request.threadId ?? "thread-new", finalText: "done" };
  }
  async interrupt(): Promise<void> {}
  async stop(): Promise<void> {}
}

async function createFixture(role: ResolvedGatewayIdentity["role"]) {
  const root = await mkdtemp(join(tmpdir(), "floral-gateway-memory-"));
  const projectDir = join(root, "Probe");
  await mkdir(projectDir);
  const canonicalProjectDir = await realpath(projectDir);
  await bootstrapProjectContext({ name: "Probe", path: canonicalProjectDir });
  const transport = new TestTransport();
  const store = new RoleStore(role);
  store.selected.set("conversation-1", "Probe");
  const gateway = new GatewayService(transport, new NoopAgent(), store, {
    cwd: canonicalProjectDir,
    workspace: new ProjectWorkspaceRoot(root),
  });
  await gateway.start();
  return { root, projectDir: canonicalProjectDir, transport, store, gateway };
}

describe("Gateway explicit durable project memory", () => {
  it("lets the owner record categorized durable memory and reports counts without model execution", async () => {
    const fixture = await createFixture("owner");
    try {
      await fixture.transport.emit(
        "/project remember decision Terminal execution permissions follow Codex-native policy.",
        "m1",
      );
      expect(fixture.transport.sent.at(-1)?.text).toContain("已记录项目决策");
      expect(fixture.store.audits).toContainEqual(expect.objectContaining({
        eventType: "command.project_memory_recorded",
        payload: expect.objectContaining({
          projectName: "Probe",
          kind: "decision",
          changed: true,
        }),
      }));

      await fixture.transport.emit("/project memory", "m2");
      const status = fixture.transport.sent.at(-1)?.text ?? "";
      expect(status).toContain("decision_entries=1");
      expect(status).toContain("explicit-owner-only");

      const decisions = await readFile(
        join(fixture.projectDir, ".floral", "DECISIONS.md"),
        "utf8",
      );
      expect(decisions).toContain("Terminal execution permissions follow Codex-native policy.");

      await fixture.transport.emit(
        "/project remember decision Terminal execution permissions follow Codex-native policy.",
        "m3",
      );
      expect(fixture.transport.sent.at(-1)?.text).toContain("已存在，未重复写入");
    } finally {
      await fixture.gateway.stop();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("denies durable memory mutation to non-owner roles", async () => {
    const fixture = await createFixture("operator");
    try {
      await fixture.transport.emit(
        "/project remember context secret stable fact",
        "m1",
      );
      expect(fixture.transport.sent.at(-1)?.text).toContain("只有 owner");
      expect(fixture.store.audits).toContainEqual(expect.objectContaining({
        eventType: "command.project_memory_denied",
        payload: { reason: "owner-required", kind: "context" },
      }));
      const context = await readFile(
        join(fixture.projectDir, ".floral", "CONTEXT.md"),
        "utf8",
      );
      expect(context).not.toContain("secret stable fact");
    } finally {
      await fixture.gateway.stop();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
