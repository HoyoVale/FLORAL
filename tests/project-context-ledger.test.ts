import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  listProjectContextLedgerEntries,
} from "../src/workspace/project-context-ledger.js";
import {
  bootstrapProjectContext,
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
});
