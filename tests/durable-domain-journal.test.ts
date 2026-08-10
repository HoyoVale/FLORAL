import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FloralContextToolController } from "../src/agent/floral-context-tools.js";
import { ExtensionControlLedger } from "../src/extensions/extension-control.js";
import { SqliteDurableJournal } from "../src/storage/durable-journal.js";
import { SqliteGatewayStore } from "../src/storage/sqlite.js";
import {
  SystemMaintenanceController,
  writeSystemMaintenanceTransaction,
} from "../src/system-maintenance/system-maintenance.js";
import { bootstrapProjectContext } from "../src/workspace/project-context.js";

describe("unified durable domain journal", () => {
  it("mirrors extension, context, and maintenance lifecycles into SQLite", async () => {
    const directory = await mkdtemp(join(tmpdir(), "floral-domain-journal-"));
    const store = await SqliteGatewayStore.open(join(directory, "gateway.sqlite"));
    const journal = new SqliteDurableJournal(store.durability);
    try {
      const extensionLedger = new ExtensionControlLedger({
        directory: join(directory, "extensions"),
        createId: () => "EXTENSION01",
        journal,
      });
      await extensionLedger.initialize();
      const extension = await extensionLedger.recordMutation({
        kind: "external-mcp",
        targetId: "github-owner",
        action: "enable",
        changed: true,
        expectedServerId: "github-owner",
      });
      expect(store.durability.findByIdempotency("extension", `extension:${extension.id}`)?.status)
        .toBe("waiting");
      await extensionLedger.recordVerification({
        transactionId: extension.id,
        kind: extension.kind,
        targetId: extension.targetId,
        action: extension.action,
        status: "verified",
        verification: "runtime-ready",
        evidence: ["mcp.status=ready"],
      });
      expect(store.durability.findByIdempotency("extension", `extension:${extension.id}`)?.status)
        .toBe("completed");

      const project = { name: "project", path: join(directory, "project") };
      await mkdir(project.path);
      await bootstrapProjectContext(project);
      const contextTools = new FloralContextToolController(journal);
      const ephemeral = await contextTools.handle({
        threadId: "thread-1",
        cwd: project.path,
        tool: "propose_update",
        callId: "call-ephemeral",
        arguments: { target: "context", text: "PID=46575" },
      });
      expect(ephemeral).toMatchObject({ success: false });
      expect(ephemeral.text).toContain("ephemeral-runtime-state");
      const proposal = await contextTools.handle({
        threadId: "thread-1",
        cwd: project.path,
        tool: "propose_update",
        callId: "call-propose",
        arguments: { target: "context", text: "Durable journal is required." },
      });
      const proposalId = /proposal_id=(ctx-[a-f0-9]{20})/u.exec(proposal.text)?.[1];
      expect(proposalId).toBeDefined();
      const applied = await contextTools.handle({
        threadId: "thread-1",
        cwd: project.path,
        tool: "apply_update",
        callId: "call-apply",
        arguments: { proposal_id: proposalId },
        approvalHandler: async () => "approve",
      });
      expect(applied.success).toBe(true);
      expect(store.durability.findByIdempotency("context", `context:${proposalId!}`)?.status)
        .toBe("completed");

      const maintenance = new SystemMaintenanceController({
        directory: join(directory, "maintenance"),
        serviceStatePath: join(directory, "service.json"),
        workerPath: join(directory, "worker.js"),
        platform: "darwin",
        createId: () => "MAINT0001",
        durableJournal: journal,
      });
      const prepared = await maintenance.prepare({
        componentId: "floral.service",
        actionId: "restart",
        rationale: "test unified journal",
      });
      expect(prepared.result.status).toBe("queued");
      expect(store.durability.findByIdempotency("maintenance", "maintenance:MAINT0001")?.status)
        .toBe("accepted");
      await maintenance.cancelQueued("MAINT0001");
      expect(store.durability.findByIdempotency("maintenance", "maintenance:MAINT0001")?.status)
        .toBe("cancelled");
    } finally {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reconciles a worker-completed maintenance receipt during startup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "floral-maintenance-reconcile-"));
    const store = await SqliteGatewayStore.open(join(directory, "gateway.sqlite"));
    const maintenanceDirectory = join(directory, "maintenance");
    try {
      await writeSystemMaintenanceTransaction(maintenanceDirectory, {
        schemaVersion: 1,
        id: "MAINT0002",
        componentId: "floral.service",
        actionId: "restart",
        status: "verified",
        requestedAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T00:01:00.000Z",
        verification: "service-ready-new-pid",
      });
      const maintenance = new SystemMaintenanceController({
        directory: maintenanceDirectory,
        serviceStatePath: join(directory, "service.json"),
        workerPath: join(directory, "worker.js"),
        platform: "darwin",
        durableJournal: new SqliteDurableJournal(store.durability),
      });
      await maintenance.initialize();
      expect(store.durability.findByIdempotency("maintenance", "maintenance:MAINT0002")?.status)
        .toBe("completed");
    } finally {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails a stale interrupted maintenance handoff instead of wedging recovery", async () => {
    const directory = await mkdtemp(join(tmpdir(), "floral-maintenance-interrupted-"));
    const store = await SqliteGatewayStore.open(join(directory, "gateway.sqlite"));
    const maintenanceDirectory = join(directory, "maintenance");
    try {
      await writeSystemMaintenanceTransaction(maintenanceDirectory, {
        schemaVersion: 1,
        id: "MAINT0003",
        componentId: "floral.service",
        actionId: "restart",
        status: "running",
        requestedAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T00:00:30.000Z",
        verification: "pending",
      });
      const maintenance = new SystemMaintenanceController({
        directory: maintenanceDirectory,
        serviceStatePath: join(directory, "service.json"),
        workerPath: join(directory, "worker.js"),
        platform: "darwin",
        now: () => new Date("2026-08-10T00:03:00.000Z"),
        recoveryTimeoutMs: 90_000,
        durableJournal: new SqliteDurableJournal(store.durability),
      });
      await maintenance.initialize();
      expect(await maintenance.readLatest()).toMatchObject({
        status: "failed",
        errorType: "MaintenanceRecoveryTimeout",
      });
      expect(store.durability.findByIdempotency("maintenance", "maintenance:MAINT0003"))
        .toMatchObject({ status: "failed", errorCode: "MaintenanceRecoveryTimeout" });
    } finally {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
