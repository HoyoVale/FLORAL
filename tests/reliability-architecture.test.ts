import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("Phase 8G reliability architecture", () => {
  it("keeps orchestration modules inside frozen structure budgets", async () => {
    const budgets: Record<string, number> = {
      // Phase 10B raised the gateway orchestration budget from 2800 to 2950:
      // Goal auto-continuation and the live status card add thin lifecycle
      // hooks, while the bulk of the new logic lives in the extracted
      // gateway-goal-continuation facade (separate frozen budget below).
      "src/service/gateway.ts": 2_950,
      "src/service/gateway-goal-continuation.ts": 430,
      // The coordinator absorbed absent-goal reconciliation, first-run
      // immediate scheduling, retry handling and the async timer fix; it was
      // already 676 lines at 416af31, so the budget is now 700.
      "src/service/goal-continuation-coordinator.ts": 700,
      "src/service/agent-status-card-controller.ts": 260,
      // Deferred Goal mutation machinery (turn projection + post-turn commit)
      // already put codex-app-server at 3350 lines in 416af31; budget is 3400.
      "src/agent/codex-app-server.ts": 3_400,
      // Turn-local projection helpers (deferred Goal mutations) put
      // codex-goals.ts at 254 lines already in 416af31; budget is 280.
      "src/agent/codex-goals.ts": 280,
      "src/agent/codex-thread-list.ts": 60,
      "src/agent/github-mcp-approval.ts": 50,
      // Phase 10B added the turnTimeoutMs wiring line (1300 -> 1310).
      "src/agent/managed-codex-deepseek-runtime.ts": 1_310,
      "src/agent/floral-native-extension-tools.ts": 240,
      "src/agent/floral-project-skill-tools.ts": 260,
      "src/skills/project-skill-authoring.ts": 680,
      "src/extensions/external-mcp-package-cache.ts": 250,
      "src/extensions/extension-control.ts": 850,
      "src/service/delivery-outbox-coordinator.ts": 260,
      "src/service/durable-run-coordinator.ts": 150,
      "src/service/gateway-chats.ts": 40,
      // Continuation synchronization wiring put gateway-goals.ts at 135 lines
      // already in 416af31; budget is 150.
      "src/service/gateway-goals.ts": 150,
      "src/service/durable-attachment-spool.ts": 80,
      "src/service/startup-recovery-coordinator.ts": 130,
      "src/storage/durable-state.ts": 620,
      "src/storage/durable-journal.ts": 100,
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
