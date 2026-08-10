import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SystemMaintenanceController,
  readLatestSystemMaintenanceTransaction,
} from "../src/system-maintenance/system-maintenance.js";
import { MaintenanceSystemObserver } from "../src/system-awareness/observers/maintenance-system-observer.js";

describe("SystemMaintenanceController", () => {
  it("queues only the declared service restart and hands it to the fixed worker", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-maintenance-"));
    const directory = join(root, "maintenance");
    let spawned: { command: string; args: string[] } | undefined;
    let unrefCalled = false;
    const controller = new SystemMaintenanceController({
      directory,
      serviceStatePath: join(root, "service-state.json"),
      workerPath: join(root, "dist", "src", "system-maintenance", "service-restart-worker.js"),
      platform: "darwin",
      createId: () => "MAINT1234",
      now: () => new Date("2026-08-10T00:00:00.000Z"),
      spawnWorker: (command, args) => {
        spawned = { command, args };
        return { unref: () => { unrefCalled = true; } } as never;
      },
    });

    try {
      const prepared = await controller.prepare({
        componentId: "floral.service",
        actionId: "restart",
        rationale: "restart after evidence-backed service failure",
      });
      expect(prepared.result).toMatchObject({
        status: "queued",
        transactionId: "MAINT1234",
      });
      expect((await readLatestSystemMaintenanceTransaction(directory))?.status)
        .toBe("approved-queued");

      await controller.execute("MAINT1234");
      expect(spawned?.command).toBe(process.execPath);
      expect(spawned?.args).toContain("--transaction");
      expect(spawned?.args).toContain("MAINT1234");
      expect(unrefCalled).toBe(true);
      expect((await readLatestSystemMaintenanceTransaction(directory))?.status)
        .toBe("handoff");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to queue a second restart while a maintenance receipt is still active", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-maintenance-single-flight-"));
    const ids = ["MAINT1111", "MAINT2222"];
    const controller = new SystemMaintenanceController({
      directory: join(root, "maintenance"),
      serviceStatePath: join(root, "service-state.json"),
      workerPath: join(root, "worker.js"),
      platform: "darwin",
      createId: () => ids.shift() ?? "MAINT9999",
    });
    try {
      const first = await controller.prepare({
        componentId: "floral.service",
        actionId: "restart",
        rationale: "first governed restart",
      });
      expect(first.result).toMatchObject({ status: "queued", transactionId: "MAINT1111" });

      const second = await controller.prepare({
        componentId: "floral.service",
        actionId: "restart",
        rationale: "duplicate governed restart",
      });
      expect(second).toEqual({
        transactionId: "MAINT1111",
        result: {
          status: "denied",
          transactionId: "MAINT1111",
          reason: "maintenance-already-in-progress",
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cancels an approved transaction cleanly when the Agent run ends before handoff", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-maintenance-cancel-"));
    const directory = join(root, "maintenance");
    const controller = new SystemMaintenanceController({
      directory,
      serviceStatePath: join(root, "service-state.json"),
      workerPath: join(root, "worker.js"),
      platform: "darwin",
      createId: () => "MAINT3333",
    });
    try {
      await controller.prepare({
        componentId: "floral.service",
        actionId: "restart",
        rationale: "approved but reply delivery later failed",
      });
      await expect(controller.cancelQueued("MAINT3333")).resolves.toBe(true);
      expect(await readLatestSystemMaintenanceTransaction(directory)).toMatchObject({
        id: "MAINT3333",
        status: "cancelled",
        cancellationReason: "run-ended-before-handoff",
      });
      await expect(controller.cancelQueued("MAINT3333")).resolves.toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("denies unsupported actions and non-macOS lifecycle execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-maintenance-deny-"));
    const controller = new SystemMaintenanceController({
      directory: join(root, "maintenance"),
      serviceStatePath: join(root, "service-state.json"),
      workerPath: join(root, "worker.js"),
      platform: "linux",
    });
    try {
      await expect(controller.prepare({
        componentId: "floral.service",
        actionId: "restart",
        rationale: "test",
      })).resolves.toEqual({
        result: { status: "denied", reason: "host-lifecycle-unavailable" },
      });
      await expect(controller.prepare({
        componentId: "codex.runtime",
        actionId: "restart",
        rationale: "test",
      })).resolves.toEqual({
        result: { status: "denied", reason: "unsupported-management-action" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("exposes the bounded maintenance receipt as authoritative System Awareness evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-maintenance-observer-"));
    const directory = join(root, "maintenance");
    const controller = new SystemMaintenanceController({
      directory,
      serviceStatePath: join(root, "service-state.json"),
      workerPath: join(root, "worker.js"),
      platform: "darwin",
      createId: () => "MAINT5678",
      now: () => new Date("2026-08-10T00:00:00.000Z"),
    });
    try {
      await controller.prepare({
        componentId: "floral.service",
        actionId: "restart",
        rationale: "bounded receipt test",
      });
      const observer = new MaintenanceSystemObserver({
        directory,
        now: () => new Date("2026-08-10T00:00:01.000Z"),
      });
      const evidence = await observer.observe();
      expect(evidence).toHaveLength(1);
      expect(evidence[0]).toMatchObject({
        componentId: "floral.maintenance",
        fact: "last_transaction",
        confidence: "authoritative",
        source: { id: "maintenance-receipt", kind: "filesystem" },
      });
      expect(JSON.stringify(evidence)).toContain("MAINT5678");
      expect(JSON.stringify(evidence).includes("launchctl")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
