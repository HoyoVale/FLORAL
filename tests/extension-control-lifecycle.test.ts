import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ExtensionControlLedger,
  readExtensionControlTransaction,
} from "../src/extensions/extension-control.js";
import { FLORAL_DYNAMIC_TOOLS } from "../src/agent/floral-tool-manifest.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Phase 9C extension transaction lifecycle", () => {
  it("supersedes an older pending transaction for the same target and keeps both addressable by id", async () => {
    const directory = await mkdtemp(join(tmpdir(), "floral-extension-lifecycle-"));
    roots.push(directory);
    const ids = ["TRANSACTION01", "TRANSACTION02"];
    const ledger = new ExtensionControlLedger({
      directory,
      createId: () => ids.shift()!,
      now: () => new Date("2026-08-11T00:00:00.000Z"),
    });
    await ledger.initialize();
    const first = await ledger.recordMutation({
      kind: "external-mcp",
      targetId: "github-readonly",
      action: "install",
      changed: true,
    });
    const second = await ledger.recordMutation({
      kind: "external-mcp",
      targetId: "github-readonly",
      action: "disable",
      changed: true,
    });

    await expect(ledger.get(first.id)).resolves.toMatchObject({
      status: "superseded",
      supersededBy: second.id,
    });
    await expect(ledger.get(second.id)).resolves.toMatchObject({ status: "pending-verification" });
    await expect(ledger.list()).resolves.toHaveLength(2);
  });

  it("updates an older transaction by id without replacing the newer latest receipt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "floral-extension-id-verify-"));
    roots.push(directory);
    const ids = ["VERIFYOLDER01", "VERIFYNEWER01"];
    let now = new Date("2026-08-11T00:00:00.000Z");
    const ledger = new ExtensionControlLedger({ directory, createId: () => ids.shift()!, now: () => now });
    await ledger.initialize();
    const older = await ledger.recordMutation({
      kind: "external-mcp",
      targetId: "github-readonly",
      action: "install",
      changed: true,
    });
    now = new Date("2026-08-11T00:01:00.000Z");
    const newer = await ledger.recordMutation({
      kind: "external-skill",
      targetId: "superpowers",
      action: "install",
      changed: true,
    });
    now = new Date("2026-08-11T00:02:00.000Z");
    await ledger.recordVerification({
      transactionId: older.id,
      kind: older.kind,
      targetId: older.targetId,
      action: older.action,
      status: "verified",
      verification: "runtime-ready",
      evidence: [],
    });

    await expect(readExtensionControlTransaction(directory, older.id)).resolves.toMatchObject({ status: "verified" });
    await expect(ledger.latest()).resolves.toMatchObject({ id: newer.id });
  });

  it("expires stale pending work during startup reconciliation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "floral-extension-expiry-"));
    roots.push(directory);
    let now = new Date("2026-08-11T00:00:00.000Z");
    const ledger = new ExtensionControlLedger({
      directory,
      createId: () => "EXPIRING001",
      now: () => now,
      verificationTtlMs: 1_000,
    });
    await ledger.initialize();
    const transaction = await ledger.recordMutation({
      kind: "external-skill",
      targetId: "superpowers",
      action: "update",
      changed: true,
    });
    now = new Date("2026-08-11T00:00:02.000Z");
    await expect(ledger.reconcile()).resolves.toHaveLength(1);
    await expect(ledger.get(transaction.id)).resolves.toMatchObject({
      status: "expired",
      verification: "verification-window-expired",
    });
  });

  it("exposes only the unified plan/apply/history/verify mutation surface", () => {
    const skills = FLORAL_DYNAMIC_TOOLS.find((entry) => entry.name === "floral_skills")!;
    const extensions = FLORAL_DYNAMIC_TOOLS.find((entry) => entry.name === "floral_extensions")!;
    expect(skills.tools.map((tool) => tool.name)).not.toContain("manage_external");
    expect(extensions.tools.map((tool) => tool.name)).not.toContain("manage_mcp");
    expect(extensions.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "plan_extension",
      "apply_extension",
      "extension_history",
      "verify_extension",
    ]));
  });
});
