import { describe, expect, it } from "vitest";
import type {
  AgentRuntime,
  ChatTransport,
  GatewayStore,
} from "../src/core/contracts.js";
import type {
  AgentApprovalDecision,
  AgentApprovalRequest,
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
        externalUserId: "owner-external",
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
      userId: "owner-1",
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

class FullProbeRuntime implements AgentRuntime {
  readonly name = "full-probe";
  readonly requests: AgentRunRequest[] = [];
  approvalDecision: AgentApprovalDecision | undefined;

  async start(): Promise<void> {}
  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    this.requests.push(request);
    if (
      request.sandboxMode === "danger-full-access"
      && request.approvalHandler
    ) {
      const approval: AgentApprovalRequest = {
        requestId: "codex-command-1",
        kind: "command-execution",
        capability: "shell.execute",
        summary: "Codex classified command approval",
        source: "codex",
      };
      this.approvalDecision = await request.approvalHandler(approval);
    }
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
  runtime: FullProbeRuntime,
  store: TestStore,
  ceiling: "auto" | "full",
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
      remoteModeCeiling: ceiling,
    },
  });
}

describe("Gateway full-auto authority", () => {
  it("fails closed when the Mac-local ceiling is only auto", async () => {
    const transport = new TestTransport();
    const runtime = new FullProbeRuntime();
    const store = new TestStore();
    const gateway = createGateway(transport, runtime, store, "auto");

    try {
      await gateway.start();
      await transport.emit("/mode full", "full-denied");
      expect(transport.sent.at(-1)?.text).toContain("本机未预授权 full 模式");

      await transport.emit("normal task", "run-after-denied");
      expect(runtime.requests[0]?.sandboxMode).toBe("workspace-write");
      expect(runtime.requests[0]?.approvalsReviewer).toBe("user");
    } finally {
      await gateway.stop();
    }
  });

  it("requires owner plus full ceiling and uses Codex dangerFullAccess with native interception", async () => {
    const transport = new TestTransport();
    const runtime = new FullProbeRuntime();
    const store = new TestStore();
    const gateway = createGateway(transport, runtime, store, "full");

    try {
      await gateway.start();
      await transport.emit("/mode full", "full-enabled");
      expect(transport.sent.at(-1)?.text).toContain("danger-full-access");

      await transport.emit("perform trusted maintenance", "full-run");
      expect(runtime.requests).toHaveLength(1);
      expect(runtime.requests[0]).toMatchObject({
        approvalPolicy: "untrusted",
        sandboxMode: "danger-full-access",
        approvalsReviewer: "user",
      });
      expect(runtime.approvalDecision).toBe("approve");
      expect(store.audit).toContainEqual(expect.objectContaining({
        eventType: "authorization.full_auto_granted",
        payload: {
          kind: "command-execution",
          capability: "shell.execute",
        },
      }));

      await transport.emit("/status --debug", "full-status");
      const status = transport.sent.at(-1)?.text ?? "";
      expect(status).toContain("mode=full");
      expect(status).toContain("mode_ceiling=full");
      expect(status).toContain("sandbox=danger-full-access");
      expect(status).toContain("approval_policy=untrusted");
      expect(status).toContain("reviewer=user");
      expect(status).toContain("approval_route=full-auto-codex-native");
    } finally {
      await gateway.stop();
    }
  });

  it("never lets an operator elevate to full even when the machine ceiling allows it", async () => {
    const transport = new TestTransport();
    const runtime = new FullProbeRuntime();
    const store = new TestStore();
    store.role = "operator";
    const gateway = createGateway(transport, runtime, store, "full");

    try {
      await gateway.start();
      await transport.emit("/mode full", "operator-full");
      expect(transport.sent.at(-1)?.text).toContain("无权提升执行模式");
      expect(store.audit).toContainEqual(expect.objectContaining({
        eventType: "command.mode_denied",
        payload: {
          requestedMode: "full",
          reason: "owner-required",
        },
      }));
    } finally {
      await gateway.stop();
    }
  });
});
