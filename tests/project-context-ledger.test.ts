import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  listProjectContextLedgerEntries,
} from "../src/workspace/project-context-ledger.js";
import {
  bootstrapProjectContext,
  refreshProjectManagedInstructions,
  reconcileProjectMemoryLedger,
  recordProjectMemory,
  verifyProjectMemoryLedgerEntry,
} from "../src/workspace/project-context.js";

describe("project context provenance ledger", () => {
  it("records content fingerprints without duplicating context text", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-context-ledger-"));
    const projectDir = join(root, "Probe");
    await mkdir(projectDir);
    const project = { name: "Probe", path: await realpath(projectDir) };
    try {
      await bootstrapProjectContext(project);
      const result = await recordProjectMemory(
        project,
        "context",
        "The Feishu transport is the production entry.",
        new Date("2026-08-10T12:00:00.000Z"),
      );
      const entries = await listProjectContextLedgerEntries(project);
      expect(entries).toEqual([expect.objectContaining({
        id: result.ledgerEntryId,
        target: "context",
        contentHash: result.fingerprint,
        source: "owner-command",
        status: "active",
        createdAt: "2026-08-10T12:00:00.000Z",
      })]);
      expect(JSON.stringify(entries)).not.toContain("Feishu transport");
      await expect(verifyProjectMemoryLedgerEntry(project, result.ledgerEntryId))
        .resolves.toEqual({
          present: true,
          target: "context",
          ledgerEntryId: result.ledgerEntryId,
        });
      expect((await listProjectContextLedgerEntries(project))[0]?.verifiedAt).toBeDefined();

      const contextPath = join(project.path, ".floral", "CONTEXT.md");
      const context = await readFile(contextPath, "utf8");
      await writeFile(
        contextPath,
        context.replace(`<!-- FLORAL:MEM:${result.fingerprint.slice(0, 16)} -->`, ""),
        "utf8",
      );
      await expect(reconcileProjectMemoryLedger(project)).resolves.toMatchObject({
        checked: 1,
        active: 0,
        stale: 1,
      });
      expect((await listProjectContextLedgerEntries(project))[0]?.status).toBe("stale");

      await recordProjectMemory(
        project,
        "context",
        "The Feishu transport is the production entry.",
        new Date("2026-08-10T13:00:00.000Z"),
      );
      expect(await listProjectContextLedgerEntries(project)).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refreshes only the FLORAL managed AGENTS block and verifies its receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-agents-refresh-"));
    const projectDir = join(root, "Probe");
    await mkdir(projectDir);
    const agentsPath = join(projectDir, "AGENTS.md");
    await writeFile(agentsPath, "# Human rules\n\nNever remove this sentence.\n", "utf8");
    const project = { name: "Probe", path: await realpath(projectDir) };
    try {
      await bootstrapProjectContext(project);
      const current = await readFile(agentsPath, "utf8");
      await writeFile(
        agentsPath,
        current.replace("Use floral_context for governed reads and updates.", "OUTDATED managed guidance."),
        "utf8",
      );
      const refreshed = await refreshProjectManagedInstructions(
        project,
        new Date("2026-08-10T14:00:00.000Z"),
      );
      expect(refreshed.changed).toBe(true);
      const next = await readFile(agentsPath, "utf8");
      expect(next).toContain("Never remove this sentence.");
      expect(next).not.toContain("OUTDATED managed guidance");
      expect(next).toContain("Use floral_context for governed reads and updates.");
      await expect(verifyProjectMemoryLedgerEntry(project, refreshed.ledgerEntryId))
        .resolves.toEqual({
          present: true,
          target: "agents",
          ledgerEntryId: refreshed.ledgerEntryId,
        });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
