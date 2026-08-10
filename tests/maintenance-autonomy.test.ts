import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isExplicitOwnerServiceRestartRequest,
  readMaintenanceAutonomyState,
} from "../src/system-maintenance/maintenance-autonomy.js";
import {
  SystemMaintenanceController,
  readLatestSystemMaintenanceTransaction,
  writeSystemMaintenanceTransaction,
} from "../src/system-maintenance/system-maintenance.js";
import { MaintenanceAutonomySupervisor, selectSelfHealRepair } from "../src/system-maintenance/maintenance-autonomy-supervisor.js";
import type { SystemDiagnosticReport } from "../src/system-awareness/system-diagnostics.js";

const BASE = new Date("2026-08-10T02:00:00.000Z");

function controllerPolicy(ceiling: "manual" | "owner-auto" | "self-heal") {
  return {
    ceiling,
    allowedActions: ["floral.service.restart"] as const,
    maxAutomaticActionsPerHour: 2,
    cooldownMs: 60_000,
    failureThreshold: 2,
    selfHealIntervalMs: 60_000,
  };
}

describe("Phase 8D.1 maintenance autonomy policy", () => {
  it("recognizes only narrow direct owner restart intent", () => {
    expect(isExplicitOwnerServiceRestartRequest("请重启")).toBe(true);
    expect(isExplicitOwnerServiceRestartRequest("请重启 FLORAL")).toBe(true);
    expect(isExplicitOwnerServiceRestartRequest("restart floral")).toBe(true);
    expect(isExplicitOwnerServiceRestartRequest("不要重启")).toBe(false);
    expect(isExplicitOwnerServiceRestartRequest("如果坏了就重启")).toBe(false);
    expect(isExplicitOwnerServiceRestartRequest("诊断一下，必要时重启")).toBe(false);
  });

  it("does not poll System Awareness on the timer while autonomy is manual", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-autonomy-manual-poll-"));
    let reads = 0;
    const controller = new SystemMaintenanceController({
      directory: join(root, "maintenance"),
      serviceStatePath: join(root, "service-state.json"),
      workerPath: join(root, "worker.js"),
      platform: "darwin",
      autonomy: controllerPolicy("self-heal"),
      now: () => BASE,
    });
    const supervisor = new MaintenanceAutonomySupervisor({
      controller,
      cwd: ".",
      systemAwareness: {
        read: async () => {
          reads += 1;
          throw new Error("manual mode must not read System Awareness");
        },
      },
    });
    try {
      await supervisor.runOnce();
      expect(reads).toBe(0);
    } finally {
      supervisor.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never lets the requested autonomy mode rise above the machine ceiling", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-autonomy-ceiling-"));
    const controller = new SystemMaintenanceController({
      directory: join(root, "maintenance"),
      serviceStatePath: join(root, "service-state.json"),
      workerPath: join(root, "worker.js"),
      platform: "darwin",
      autonomy: controllerPolicy("owner-auto"),
      now: () => BASE,
    });
    try {
      await controller.initialize();
      await expect(controller.setAutonomyMode("self-heal")).resolves.toMatchObject({
        status: "denied",
        reason: "machine-ceiling",
        policy: { ceiling: "owner-auto", effectiveMode: "manual" },
      });
      await expect(controller.setAutonomyMode("owner-auto")).resolves.toMatchObject({
        status: "updated",
        policy: { ceiling: "owner-auto", effectiveMode: "owner-auto" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("enforces cooldown and hourly limits for automatically approved actions", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-autonomy-rate-"));
    let nowMs = BASE.getTime();
    let counter = 0;
    const controller = new SystemMaintenanceController({
      directory: join(root, "maintenance"),
      serviceStatePath: join(root, "service-state.json"),
      workerPath: join(root, "worker.js"),
      platform: "darwin",
      autonomy: controllerPolicy("owner-auto"),
      now: () => new Date(nowMs),
      createId: () => `AUTO${String(++counter).padStart(4, "0")}`,
    });
    try {
      await controller.setAutonomyMode("owner-auto");
      const first = await controller.prepare({
        componentId: "floral.service",
        actionId: "restart",
        rationale: "direct owner restart",
      }, { trigger: "owner-auto" });
      expect(first.result.status).toBe("queued");
      await controller.cancelQueued(first.transactionId!);
      await expect(controller.automaticApprovalAllowed("owner-auto")).resolves.toEqual({
        allowed: false,
        reason: "cooldown",
      });

      nowMs += 61_000;
      expect((await controller.automaticApprovalAllowed("owner-auto")).allowed).toBe(true);
      const second = await controller.prepare({
        componentId: "floral.service",
        actionId: "restart",
        rationale: "second direct owner restart",
      }, { trigger: "owner-auto" });
      expect(second.result.status).toBe("queued");
      await controller.cancelQueued(second.transactionId!);
      nowMs += 61_000;
      await expect(controller.automaticApprovalAllowed("owner-auto")).resolves.toEqual({
        allowed: false,
        reason: "rate-limit",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("opens the self-heal circuit breaker when verified restarts do not clear the original finding", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-autonomy-breaker-"));
    const directory = join(root, "maintenance");
    const controller = new SystemMaintenanceController({
      directory,
      serviceStatePath: join(root, "service-state.json"),
      workerPath: join(root, "worker.js"),
      platform: "darwin",
      autonomy: controllerPolicy("self-heal"),
      now: () => BASE,
    });
    try {
      await controller.setAutonomyMode("self-heal");
      for (const id of ["HEAL0001", "HEAL0002"]) {
        await writeSystemMaintenanceTransaction(directory, {
          schemaVersion: 1,
          id,
          componentId: "floral.service",
          actionId: "restart",
          status: "verified",
          requestedAt: BASE.toISOString(),
          updatedAt: BASE.toISOString(),
          verification: "service-ready-new-pid",
          trigger: "self-heal",
          diagnosticFindingIds: ["mcp.floral_search.runtime-failed"],
          notificationStatus: "pending",
        });
        await controller.reconcileSelfHealOutcome(["mcp.floral_search.runtime-failed"]);
      }
      expect(await readLatestSystemMaintenanceTransaction(directory)).toMatchObject({
        id: "HEAL0002",
        repairOutcome: "persistent",
      });
      expect(await controller.autonomyStatus()).toMatchObject({
        consecutiveSelfHealFailures: 2,
        circuitBreakerOpen: true,
      });
      expect((await controller.automaticApprovalAllowed("self-heal")).reason).toBe("circuit-breaker-open");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("marks a verified self-heal resolved only after the original finding disappears", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-autonomy-resolved-"));
    const directory = join(root, "maintenance");
    const controller = new SystemMaintenanceController({
      directory,
      serviceStatePath: join(root, "service-state.json"),
      workerPath: join(root, "worker.js"),
      platform: "darwin",
      autonomy: controllerPolicy("self-heal"),
      now: () => BASE,
    });
    try {
      await writeSystemMaintenanceTransaction(directory, {
        schemaVersion: 1,
        id: "HEAL1001",
        componentId: "floral.service",
        actionId: "restart",
        status: "verified",
        requestedAt: BASE.toISOString(),
        updatedAt: BASE.toISOString(),
        verification: "service-ready-new-pid",
        trigger: "self-heal",
        diagnosticFindingIds: ["mcp.floral_search.runtime-failed"],
        notificationStatus: "pending",
      });
      await controller.reconcileSelfHealOutcome([]);
      expect(await readLatestSystemMaintenanceTransaction(directory)).toMatchObject({
        repairOutcome: "resolved",
      });
      expect(await controller.autonomyStatus()).toMatchObject({
        consecutiveSelfHealFailures: 0,
        circuitBreakerOpen: false,
      });
      expect((await readMaintenanceAutonomyState(directory))?.lastReconciledTransactionId)
        .toBe("HEAL1001");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("selects self-heal only for high-confidence built-in MCP failed/cancelled findings", () => {
    const report = (findings: SystemDiagnosticReport["findings"]): SystemDiagnosticReport => ({
      schemaVersion: 1,
      generatedAt: BASE.toISOString(),
      snapshotGeneratedAt: BASE.toISOString(),
      definitionFingerprint: "0".repeat(64),
      scope: "all",
      overallStatus: "unavailable",
      findings,
      executionPerformed: false,
      maintenanceEnabled: true,
    });
    const base = {
      severity: "error" as const,
      status: "unavailable" as const,
      impact: "unavailable" as const,
      confidence: "high" as const,
      summary: "runtime failed",
      candidateFailureDomains: ["floral"] as const,
      evidence: [],
      checks: [],
      limitations: [],
    };
    expect(selectSelfHealRepair(report([{ ...base, id: "mcp.floral_search.runtime-failed", componentId: "mcp.floral_search" }]))).toMatchObject({
      componentId: "floral.service",
      actionId: "restart",
      findingIds: ["mcp.floral_search.runtime-failed"],
    });
    expect(selectSelfHealRepair(report([{ ...base, id: "extensions.external_mcp.github.runtime-failed", componentId: "extensions.external_mcp" }]))).toBeUndefined();
    expect(selectSelfHealRepair(report([{ ...base, id: "mcp.floral_search.runtime-starting", componentId: "mcp.floral_search" }]))).toBeUndefined();
    expect(selectSelfHealRepair(report([{ ...base, confidence: "medium" as const, id: "mcp.floral_search.runtime-failed", componentId: "mcp.floral_search" }]))).toBeUndefined();
  });
});
