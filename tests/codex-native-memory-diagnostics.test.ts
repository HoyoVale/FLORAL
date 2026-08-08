import Database from "better-sqlite3";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyMemoryJobError,
  readCodexNativeMemoryPhase2Diagnostics,
  renderCodexNativeMemoryPhase2DiagnosticLines,
} from "../src/agent/codex-native-memory-diagnostics.js";
import type { CodexNativeMemoryRuntimeStatus } from "../src/agent/codex-native-memory-status.js";

function generatedRuntime(): CodexNativeMemoryRuntimeStatus {
  return {
    configured: true,
    useMemories: true,
    generateMemories: true,
    disableOnExternalContext: false,
    control: "config",
    scope: "codex-home",
    activeConfig: "unified",
    runtimeConfig: "present",
    effective: true,
    storage: "present",
    memoryIndex: "absent",
    memorySummary: "absent",
    rawMemories: "present",
    rolloutSummaryCount: 2,
    memoryIndexBytes: 0,
    memorySummaryBytes: 0,
    rawMemoriesBytes: 12024,
    lifecycle: "generated",
  };
}

describe("Codex native memory Phase 2 diagnostics", () => {
  it("reads memory job metadata without exposing the raw last_error text", async () => {
    const home = await mkdtemp(join(tmpdir(), "floral-native-memory-diagnostic-"));
    try {
      const memories = join(home, "memories");
      await mkdir(join(memories, ".git"), { recursive: true });
      await writeFile(join(memories, "raw_memories.md"), "sensitive raw memory", "utf8");
      await writeFile(join(memories, "phase2_workspace_diff.md"), "sensitive diff", "utf8");

      const db = new Database(join(home, "state_5.sqlite"));
      db.exec(`
        CREATE TABLE stage1_outputs (
          thread_id TEXT PRIMARY KEY,
          selected_for_phase2 INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE jobs (
          kind TEXT NOT NULL,
          job_key TEXT NOT NULL,
          status TEXT NOT NULL,
          retry_remaining INTEGER,
          last_error TEXT
        );
        INSERT INTO stage1_outputs(thread_id, selected_for_phase2) VALUES ('a', 0), ('b', 0);
        INSERT INTO jobs(kind, job_key, status, retry_remaining, last_error)
          VALUES ('memory_stage1', 'a', 'done', 0, NULL);
        INSERT INTO jobs(kind, job_key, status, retry_remaining, last_error)
          VALUES ('memory_stage1', 'b', 'done', 0, NULL);
        INSERT INTO jobs(kind, job_key, status, retry_remaining, last_error)
          VALUES (
            'memory_consolidate_global',
            'global',
            'error',
            2,
            'sandbox-exec: sandbox_apply: Operation not permitted /Users/private/path'
          );
      `);
      db.close();

      const result = await readCodexNativeMemoryPhase2Diagnostics({
        managedHome: home,
        runtime: generatedRuntime(),
      });
      expect(result).toMatchObject({
        database: "read-only",
        databaseFile: "state_5.sqlite",
        stage1Outputs: 2,
        stage1SelectedForPhase2: 0,
        stage1JobsDone: 2,
        phase2Job: "present",
        phase2Status: "error",
        phase2RetryRemaining: 2,
        phase2ErrorClass: "sandbox",
        phase2WorkspaceDiff: "present",
        memoryGitBaseline: "present",
        diagnosis: "blocked:sandbox",
      });
      const rendered = renderCodexNativeMemoryPhase2DiagnosticLines(result).join("\n");
      expect(rendered).toContain("codex_memory_phase2_error_class=sandbox");
      expect(rendered).not.toContain("/Users/private/path");
      expect(rendered).not.toContain("sensitive raw memory");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("recognizes a consolidated memory_summary artifact without reading it", async () => {
    const home = await mkdtemp(join(tmpdir(), "floral-native-memory-summary-"));
    try {
      const memories = join(home, "memories");
      await mkdir(memories, { recursive: true });
      await writeFile(join(memories, "memory_summary.md"), "private summary text", "utf8");
      const result = await readCodexNativeMemoryPhase2Diagnostics({
        managedHome: home,
        runtime: generatedRuntime(),
      });
      expect(result.memorySummary).toBe("present");
      expect(result.diagnosis).toBe("consolidated");
      expect(renderCodexNativeMemoryPhase2DiagnosticLines(result).join("\n"))
        .not.toContain("private summary text");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("classifies failure reasons into bounded non-secret categories", () => {
    expect(classifyMemoryJobError("sandbox-exec: sandbox_apply: Operation not permitted"))
      .toBe("sandbox");
    expect(classifyMemoryJobError("timeout waiting for child process to exit"))
      .toBe("timeout");
    expect(classifyMemoryJobError("context_length_exceeded"))
      .toBe("context-window");
    expect(classifyMemoryJobError("provider HTTP connection failed"))
      .toBe("provider");
  });
});
