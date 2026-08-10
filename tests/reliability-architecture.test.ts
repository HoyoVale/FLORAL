import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("Phase 8G reliability architecture", () => {
  it("keeps orchestration modules inside frozen structure budgets", async () => {
    const budgets: Record<string, number> = {
      "src/service/gateway.ts": 2_800,
      "src/agent/codex-app-server.ts": 3_250,
      "src/agent/managed-codex-deepseek-runtime.ts": 1_300,
      "src/service/delivery-outbox-coordinator.ts": 260,
      "src/service/durable-run-coordinator.ts": 150,
      "src/service/durable-attachment-spool.ts": 80,
      "src/service/startup-recovery-coordinator.ts": 130,
      "src/storage/durable-state.ts": 620,
      "src/storage/durable-outbox.ts": 380,
      "src/storage/durable-run-queue.ts": 370,
    };
    for (const [path, maximum] of Object.entries(budgets)) {
      const content = await readFile(`${root}/${path}`, "utf8");
      const lines = content.split(/\r?\n/u).length;
      expect(lines, `${path} exceeded its structure budget`).toBeLessThanOrEqual(maximum);
    }
  });

  it("freezes the recovery matrix and owner publication boundary", async () => {
    const [contract, registry, agents] = await Promise.all([
      readFile(`${root}/docs/PHASE8G_RELIABILITY_ARCHITECTURE.md`, "utf8"),
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
    expect(registry).toContain("github-owner");
    expect(registry).toContain("create_or_update_file,push_files,delete_file");
    expect(registry).toContain("merge_pull_request");
  });
});
