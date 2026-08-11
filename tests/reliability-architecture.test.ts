import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("Phase 8G reliability architecture", () => {
  it("freezes the recovery matrix and owner publication boundary", async () => {
    const [contract, audit, registry, agents] = await Promise.all([
      readFile(`${root}/docs/PHASE8G_RELIABILITY_ARCHITECTURE.md`, "utf8"),
      readFile(`${root}/docs/PHASE8G_COMPLETION_AUDIT.md`, "utf8"),
      readFile(`${root}/src/extensions/external-mcp-registry.ts`, "utf8"),
      readFile(`${root}/AGENTS.md`, "utf8"),
    ]);
    for (const expected of [
      "Duplicate inbound message",
      "FLORAL crash with a not-yet-started queued run",
      "FLORAL crash during an executing run",
      "Feishu send timeout",
      "Non-idempotent transport timeout",
      "SQLite unavailable/corrupt",
      "Context body/ledger drift",
    ]) {
      expect(contract).toContain(expected);
    }
    expect(agents).toContain("Git commit/push is performed by the project owner");
    expect(audit).toContain("8G.8 soak closure");
    expect(audit).toContain("SQLite busy/corrupt/unavailable/full");
    expect(registry).toContain("github-owner");
    expect(registry).toContain("create_or_update_file,push_files,delete_file");
    expect(registry).toContain("merge_pull_request");
  });
});
