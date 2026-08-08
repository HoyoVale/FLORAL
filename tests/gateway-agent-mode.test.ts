import { describe, expect, it } from "vitest";
import type {
  AgentRuntime,
  ChatTransport,
  GatewayStore,
} from "../src/core/contracts.js";
import type {
  AgentRunRequest,
  AgentRunResult,
  AuditEventInput,
  IncomingMessage,
  OutgoingMessage,
  ResolvedGatewayIdentity,
} from "../src/core/types.js";
import type { McpRuntimeRegistry } from "../src/config/mcp/mcp-runtime-registry.js";
import { AuthorizationAuthority } from "../src/policy/authorization-authority.js";
import { GatewayService } from "../src/service/gateway.js";

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
        externalUserId: "user-external",
        conversationId: "conversation-1",
      },
      text,
      receivedAt: new Date(),
    });
  }
}

class TestStore implements GatewayStore {
  threadId: string | undefined;
  role: ResolvedGatewayIdentity["role"] = "owner";
  readonly audit: AuditEventInput[] = [];

  async resolveIdentity(): Promise<ResolvedGatewayIdentity> {
    return {
      userId: "user-1",
      role: this.role,
      conversationId: "conversation-1",
    };
  }

  async claimOwner(): Promise<ResolvedGatewayIdentity> {
    return await this.resolveIdentity();
  }

  async hasOwner(): Promise<boolean> {
    return true;
  }

  async acceptMessage(): Promise<boolean> {
    return true;
  }

  async getActiveThread(): Promise<string | undefined> {
    return this.threadId;
  }

  async setActiveThread(_conversationId: string, threadId: string): Promise<void> {
    this.threadId = threadId;
  }

  async clearActiveThread(): Promise<void> {
    this.threadId = undefined;
  }

  async appendAudit(event: AuditEventInput): Promise<void> {
    this.audit.push(event);
  }

  async close(): Promise<void> {}
}

class CaptureRuntime implements AgentRuntime {
  readonly name = "capture";
  readonly requests: AgentRunRequest[] = [];

  async start(): Promise<void> {}

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    this.requests.push(request);
    return { threadId: "thread-1", finalText: "done" };
  }

  async interrupt(): Promise<void> {}
  async stop(): Promise<void> {}
}

function emptyRegistry(): McpRuntimeRegistry {
  return {
    schemaVersion: 1,
    authorityVersion: 1,
    profile: "test",
    registryFingerprint: "test",
    servers: [],
  };
}

function createGateway(
  transport: TestTransport,
  runtime: CaptureRuntime,
  store: TestStore,
): GatewayService {
  return new GatewayService(transport, runtime, store, {
    cwd: process.cwd(),
    authorization: {
      authority: new AuthorizationAuthority({
        enabled: true,
        sandboxMode: "workspace-write",
        allowRemoteFileChangeApproval: true,
        mcpRegistry: emptyRegistry(),
      }),
      approvalTtlMs: 5_000,
      maxPendingApprovals: 4,
      ownerOnlyRemoteApproval: true,
    },
  });
}

describe("Gateway Codex-native execution mode", () => {
  it("defaults to ask, switches owner to auto_review, and returns to ask", async () => {
    const transport = new TestTransport();
    const runtime = new CaptureRuntime();
    const store = new TestStore();
    const gateway = createGateway(transport, runtime, store);

    try {
      await gateway.start();

      await transport.emit("/mode", "mode-1");
      expect(transport.sent.at(-1)?.text).toContain("执行模式=ask");

      await transport.emit("/mode auto", "mode-2");
      expect(transport.sent.at(-1)?.text).toContain("auto_review");

      await transport.emit("do work", "run-1");
      expect(runtime.requests).toHaveLength(1);
      expect(runtime.requests[0]?.approvalsReviewer).toBe("auto_review");
      expect(runtime.requests[0]?.approvalHandler).toBeUndefined();

      await transport.emit("/status --debug", "status-1");
      expect(transport.sent.at(-1)?.text).toContain("mode=auto");

      await transport.emit("/mode ask", "mode-3");
      await transport.emit("do work with approval", "run-2");
      expect(runtime.requests).toHaveLength(2);
      expect(runtime.requests[1]?.approvalsReviewer).toBe("user");
      expect(runtime.requests[1]?.approvalHandler).toBeTypeOf("function");
    } finally {
      await gateway.stop();
    }
  });

  it("does not let a non-owner raise the conversation into auto mode", async () => {
    const transport = new TestTransport();
    const runtime = new CaptureRuntime();
    const store = new TestStore();
    store.role = "operator";
    const gateway = createGateway(transport, runtime, store);

    try {
      await gateway.start();
      await transport.emit("/mode auto", "mode-denied");
      expect(transport.sent.at(-1)?.text).toContain("无权启用");
      expect(store.audit).toContainEqual(expect.objectContaining({
        eventType: "command.mode_denied",
      }));

      await transport.emit("normal task", "run-operator");
      expect(runtime.requests[0]?.approvalsReviewer).toBe("user");
    } finally {
      await gateway.stop();
    }
  });
});
