import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRuntime, ChatTransport } from "../src/core/contracts.js";
import type {
  AgentRunRequest,
  AgentRunResult,
  IncomingMessage,
  OutgoingMessage,
} from "../src/core/types.js";
import type { McpRuntimeRegistry } from "../src/config/mcp/mcp-runtime-registry.js";
import { AuthorizationAuthority } from "../src/policy/authorization-authority.js";
import {
  LocalConfirmationBroker,
  writeLocalApprovalDecision,
} from "../src/policy/local-confirmation-broker.js";
import { GatewayService } from "../src/service/gateway.js";
import { MemoryThreadStore } from "../src/storage/memory-thread-store.js";
import {
  SystemMaintenanceController,
  readLatestSystemMaintenanceTransaction,
} from "../src/system-maintenance/system-maintenance.js";

class TestTransport implements ChatTransport {
  readonly name = "maintenance-test";
  readonly sent: OutgoingMessage[] = [];
  #handler: ((message: IncomingMessage) => Promise<void>) | undefined;

  async start(handler: (message: IncomingMessage) => Promise<void>): Promise<void> {
    this.#handler = handler;
  }

  async send(message: OutgoingMessage): Promise<void> {
    this.sent.push(message);
  }

  async stop(): Promise<void> {}

  async receive(text: string): Promise<void> {
    if (!this.#handler) throw new Error("transport not started");
    await this.#handler({
      id: "maintenance-message",
      identity: {
        transport: "mock",
        botId: "bot",
        externalUserId: "owner",
        conversationId: "conversation-maintenance",
      },
      text,
      receivedAt: new Date(),
    });
  }
}

class FailingFinalTransport extends TestTransport {
  override async send(message: OutgoingMessage): Promise<void> {
    this.sent.push(message);
    if (message.text === "maintenance queued") throw new Error("final delivery failed");
  }
}

class MaintenanceAgent implements AgentRuntime {
  readonly name = "maintenance-agent";

  async start(): Promise<void> {}

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    if (!request.systemMaintenanceApprovalHandler || !request.systemMaintenanceHandler) {
      throw new Error("missing system maintenance handlers");
    }
    const decision = await request.systemMaintenanceApprovalHandler({
      requestId: "maintenance-agent-request",
      kind: "system-maintenance",
      capability: "system.restart",
      summary: "evidence-backed bounded restart",
      source: "floral",
    });
    if (decision !== "approve") {
      return { threadId: "thread-maintenance", finalText: "maintenance denied" };
    }
    const queued = await request.systemMaintenanceHandler({
      componentId: "floral.service",
      actionId: "restart",
      rationale: "service restart acceptance test",
    });
    if (queued.status !== "queued") {
      throw new Error(`unexpected maintenance result: ${queued.status}`);
    }
    return { threadId: "thread-maintenance", finalText: "maintenance queued" };
  }

  async interrupt(): Promise<void> {}
  async stop(): Promise<void> {}
}

function emptyRegistry(): McpRuntimeRegistry {
  return {
    schemaVersion: 1,
    authorityVersion: 1,
    profile: "test",
    registryFingerprint: "maintenance-test",
    servers: [],
  };
}

describe("Gateway controlled system maintenance", () => {
  it("requires Mac-local approval and hands restart to the fixed worker only after final reply delivery", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-gateway-maintenance-"));
    const transport = new TestTransport();
    const store = new MemoryThreadStore();
    const localDirectory = join(root, "local-approval");
    const local = new LocalConfirmationBroker({
      directory: localDirectory,
      ttlMs: 5_000,
      pollIntervalMs: 50,
      maxPending: 2,
      enabled: true,
      createPublicId: () => "LOCAL888",
      createSessionId: () => "session-maintenance",
    });
    let spawnedAfterFinalReply = false;
    const controller = new SystemMaintenanceController({
      directory: join(root, "maintenance"),
      serviceStatePath: join(root, "service-state.json"),
      workerPath: join(root, "worker.js"),
      platform: "darwin",
      createId: () => "MAINT8888",
      spawnWorker: () => {
        spawnedAfterFinalReply = transport.sent.some((message) => message.text === "maintenance queued");
        return { unref: () => undefined } as never;
      },
    });
    const gateway = new GatewayService(
      transport,
      new MaintenanceAgent(),
      store,
      {
        cwd: process.cwd(),
        trustMockOwner: true,
        authorization: {
          authority: new AuthorizationAuthority({
            enabled: true,
            sandboxMode: "read-only",
            allowRemoteFileChangeApproval: false,
            mcpRegistry: emptyRegistry(),
          }),
          approvalTtlMs: 5_000,
          maxPendingApprovals: 2,
          ownerOnlyRemoteApproval: true,
          localConfirmation: local,
        },
        systemMaintenance: { controller },
      },
    );

    try {
      await gateway.start();
      const receive = transport.receive("Restart FLORAL through governed maintenance.");
      let written: Awaited<ReturnType<typeof writeLocalApprovalDecision>> = "not-found";
      for (let attempt = 0; attempt < 50 && written === "not-found"; attempt += 1) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
        written = await writeLocalApprovalDecision(localDirectory, "LOCAL888", "approve");
      }
      expect(written).toBe("written");
      await receive;

      expect(transport.sent.some((message) => message.text.includes("Mac 本地确认"))).toBe(true);
      expect(transport.sent.some((message) => message.text === "maintenance queued")).toBe(true);
      expect(spawnedAfterFinalReply).toBe(true);
    } finally {
      await gateway.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cancels the queued restart when the initiating final reply cannot be delivered", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-gateway-maintenance-delivery-"));
    const transport = new FailingFinalTransport();
    const localDirectory = join(root, "local-approval");
    const local = new LocalConfirmationBroker({
      directory: localDirectory,
      ttlMs: 5_000,
      pollIntervalMs: 50,
      maxPending: 2,
      enabled: true,
      createPublicId: () => "LOCAL999",
      createSessionId: () => "session-maintenance-failed-delivery",
    });
    let spawned = false;
    const maintenanceDirectory = join(root, "maintenance");
    const controller = new SystemMaintenanceController({
      directory: maintenanceDirectory,
      serviceStatePath: join(root, "service-state.json"),
      workerPath: join(root, "worker.js"),
      platform: "darwin",
      createId: () => "MAINT9999",
      spawnWorker: () => {
        spawned = true;
        return { unref: () => undefined } as never;
      },
    });
    const gateway = new GatewayService(
      transport,
      new MaintenanceAgent(),
      new MemoryThreadStore(),
      {
        cwd: process.cwd(),
        trustMockOwner: true,
        authorization: {
          authority: new AuthorizationAuthority({
            enabled: true,
            sandboxMode: "read-only",
            allowRemoteFileChangeApproval: false,
            mcpRegistry: emptyRegistry(),
          }),
          approvalTtlMs: 5_000,
          maxPendingApprovals: 2,
          ownerOnlyRemoteApproval: true,
          localConfirmation: local,
        },
        systemMaintenance: { controller },
      },
    );

    try {
      await gateway.start();
      const receive = transport.receive("Restart FLORAL through governed maintenance.");
      let written: Awaited<ReturnType<typeof writeLocalApprovalDecision>> = "not-found";
      for (let attempt = 0; attempt < 50 && written === "not-found"; attempt += 1) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
        written = await writeLocalApprovalDecision(localDirectory, "LOCAL999", "approve");
      }
      expect(written).toBe("written");
      await receive;

      expect(spawned).toBe(false);
      expect(await readLatestSystemMaintenanceTransaction(maintenanceDirectory)).toMatchObject({
        id: "MAINT9999",
        status: "cancelled",
        cancellationReason: "final-reply-delivery-failed",
      });
    } finally {
      await gateway.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});
