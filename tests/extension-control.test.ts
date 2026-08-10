import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EXTENSION_CONTROL_SCHEMA_VERSION,
  ExtensionControlLedger,
  buildExtensionPlan,
  buildExtensionVerification,
  readExtensionControlTransactionFromSnapshot,
} from "../src/extensions/extension-control.js";
import {
  SYSTEM_AWARENESS_SCHEMA_VERSION,
  type SystemComponentSnapshot,
  type SystemEvidenceValue,
  type SystemSnapshot,
} from "../src/system-awareness/system-types.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function snapshot(components: SystemComponentSnapshot[]): SystemSnapshot {
  return {
    schemaVersion: SYSTEM_AWARENESS_SCHEMA_VERSION,
    generatedAt: "2026-08-10T00:00:00.000Z",
    definitionFingerprint: "a".repeat(64),
    components,
    observers: [],
  };
}

function resolvedComponent(
  componentId: string,
  facts: Record<string, SystemEvidenceValue>,
): SystemComponentSnapshot {
  return {
    componentId,
    observed: true,
    facts: Object.entries(facts).map(([fact, value]) => ({
      fact,
      resolution: "resolved" as const,
      confidence: "authoritative" as const,
      value,
      evidence: [],
    })),
  };
}

describe("Phase 8E controlled extension planning and verification", () => {
  it("plans installation for an absent curated MCP instead of guessing runtime state", () => {
    const plan = buildExtensionPlan(snapshot([
      resolvedComponent("extensions.external_mcp", { packages: [], auth_presence: [] }),
      resolvedComponent("codex.mcp", { servers: [] }),
    ]), { kind: "mcp", id: "github-readonly", intent: "activate" });

    expect(plan).toMatchObject({
      status: "action-required",
      currentState: "absent",
      recommendedAction: "install",
      capability: "extension.install",
      approval: "chat-confirmation",
    });
  });

  it("stops at a missing MCP credential prerequisite instead of recommending reinstall", () => {
    const plan = buildExtensionPlan(snapshot([
      resolvedComponent("extensions.external_mcp", {
        packages: [{ id: "github-readonly", serverId: "github", enabled: true }],
        auth_presence: [{ id: "github-readonly", requirement: "bearer-token", env: "GITHUB_PAT_TOKEN", present: false }],
      }),
      resolvedComponent("codex.mcp", { servers: [] }),
    ]), { kind: "mcp", id: "github-readonly", intent: "activate" });

    expect(plan.status).toBe("prerequisite-required");
    expect(plan.prerequisite).toBe("GITHUB_PAT_TOKEN");
    expect(plan.recommendedAction).toBeUndefined();
  });

  it("verifies a curated MCP only when registry, auth, server status, and tools agree", () => {
    const result = buildExtensionVerification(snapshot([
      resolvedComponent("extensions.external_mcp", {
        packages: [{ id: "github-readonly", serverId: "github", enabled: true }],
        auth_presence: [{ id: "github-readonly", requirement: "bearer-token", env: "GITHUB_PAT_TOKEN", present: true }],
      }),
      resolvedComponent("codex.mcp", {
        servers: [{ name: "github", status: "ready", tools: [{ name: "search_repositories" }] }],
      }),
    ]), {
      schemaVersion: EXTENSION_CONTROL_SCHEMA_VERSION,
      id: "EXTENSION01",
      kind: "external-mcp",
      targetId: "github-readonly",
      action: "install",
      status: "pending-verification",
      requestedAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z",
      changed: true,
      expectedServerId: "github",
    });

    expect(result.status).toBe("verified");
    expect(result.verification).toBe("runtime-ready-with-tools");
  });

  it("keeps App install verification user-mediated when installed authority has not observed success", () => {
    const result = buildExtensionVerification(snapshot([
      resolvedComponent("codex.apps", { installed: [] }),
    ]), {
      schemaVersion: EXTENSION_CONTROL_SCHEMA_VERSION,
      id: "APPHANDOFF01",
      kind: "app",
      targetId: "calendar",
      action: "install-handoff",
      status: "pending-user-action",
      requestedAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z",
    });

    expect(result.status).toBe("pending-user-action");
    expect(result.verification).toBe("upstream-install-not-yet-observed");
  });

  it("plans installed App enable/disable through Codex native config while keeping install user-mediated", () => {
    const disabled = snapshot([
      resolvedComponent("codex.apps", {
        installed: [{ id: "github", enabled: false, callable: false }],
        directory: [{ id: "github", accessible: true, installSupported: true }],
      }),
    ]);
    expect(buildExtensionPlan(disabled, {
      kind: "app",
      id: "github",
      intent: "activate",
    })).toMatchObject({
      status: "action-required",
      recommendedAction: "enable",
      capability: "extension.enable",
    });

    const enabled = snapshot([
      resolvedComponent("codex.apps", {
        installed: [{ id: "github", enabled: true, callable: true }],
      }),
    ]);
    expect(buildExtensionPlan(enabled, {
      kind: "app",
      id: "github",
      intent: "disable",
    })).toMatchObject({
      status: "action-required",
      recommendedAction: "disable",
      capability: "extension.disable",
    });
  });

  it("verifies an App disable only from fresh installed-runtime evidence", () => {
    const result = buildExtensionVerification(snapshot([
      resolvedComponent("codex.apps", {
        installed: [{ id: "github", enabled: false, callable: false }],
      }),
    ]), {
      schemaVersion: EXTENSION_CONTROL_SCHEMA_VERSION,
      id: "APPCONFIG01",
      kind: "app",
      targetId: "github",
      action: "disable",
      status: "pending-verification",
      requestedAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z",
    });
    expect(result).toMatchObject({
      status: "verified",
      verification: "app-disabled-and-not-callable",
    });
  });

  it("persists a bounded receipt that can be reconstructed from System Awareness", async () => {
    const directory = await mkdtemp(join(tmpdir(), "floral-extension-control-"));
    directories.push(directory);
    const ledger = new ExtensionControlLedger({
      directory,
      now: () => new Date("2026-08-10T00:00:00.000Z"),
      createId: () => "CONTROL1234",
    });
    const transaction = await ledger.recordMutation({
      kind: "external-skill",
      targetId: "superpowers",
      action: "enable",
      changed: true,
      expectedSkillNames: ["brainstorming"],
    });

    const reconstructed = readExtensionControlTransactionFromSnapshot(snapshot([
      resolvedComponent("floral.extension_control", {
        last_transaction: {
          schemaVersion: transaction.schemaVersion,
          id: transaction.id,
          kind: transaction.kind,
          targetId: transaction.targetId,
          action: transaction.action,
          status: transaction.status,
          requestedAt: transaction.requestedAt,
          updatedAt: transaction.updatedAt,
          changed: transaction.changed ?? null,
          expectedServerId: null,
          expectedSkillNames: transaction.expectedSkillNames ?? [],
          verification: transaction.verification ?? null,
          errorType: null,
        },
      }),
    ]));

    expect(reconstructed).toMatchObject({
      id: "CONTROL1234",
      kind: "external-skill",
      targetId: "superpowers",
      action: "enable",
      status: "pending-verification",
      expectedSkillNames: ["brainstorming"],
    });
  });
});
