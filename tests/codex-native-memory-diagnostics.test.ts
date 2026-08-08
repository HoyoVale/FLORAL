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
    memorySummarySchema: "absent",
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
          started_at INTEGER,
          finished_at INTEGER,
          retry_at INTEGER,
          input_watermark INTEGER,
          last_success_watermark INTEGER,
          last_error TEXT
        );
        INSERT INTO stage1_outputs(thread_id, selected_for_phase2) VALUES ('a', 0), ('b', 0);
        INSERT INTO jobs(kind, job_key, status, retry_remaining, last_error)
          VALUES ('memory_stage1', 'a', 'done', 0, NULL);
        INSERT INTO jobs(kind, job_key, status, retry_remaining, last_error)
          VALUES ('memory_stage1', 'b', 'done', 0, NULL);
        INSERT INTO jobs(
          kind, job_key, status, retry_remaining, started_at, finished_at, retry_at,
          input_watermark, last_success_watermark, last_error
        ) VALUES (
          'memory_consolidate_global',
          'global',
          'error',
          2,
          1786207620,
          1786207657,
          1786208257,
          1786207600,
          0,
          'sandbox-exec: sandbox_apply: Operation not permitted /Users/private/path'
        );
      `);
      db.close();

      const result = await readCodexNativeMemoryPhase2Diagnostics({
        managedHome: home,
        runtime: generatedRuntime(),
        nowMs: 1_786_207_700_000,
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
        phase2StartedAt: "2026-08-08T16:47:00.000Z",
        phase2FinishedAt: "2026-08-08T16:47:37.000Z",
        phase2RetryAt: "2026-08-08T16:57:37.000Z",
        phase2RetryState: "backoff",
        phase2RetryWaitSeconds: 557,
        phase2InputWatermark: "1786207600",
        phase2LastSuccessWatermark: "0",
        phase2ErrorClass: "sandbox",
        phase2WorkspaceDiff: "present",
        memoryGitBaseline: "present",
        diagnosis: "waiting:phase2-backoff:sandbox",
      });
      const rendered = renderCodexNativeMemoryPhase2DiagnosticLines(result).join("\n");
      expect(rendered).toContain("codex_memory_phase2_retry_state=backoff");
      expect(rendered).toContain("codex_memory_phase2_retry_at=2026-08-08T16:57:37.000Z");
      expect(rendered).toContain("codex_memory_phase2_error_class=sandbox");
      expect(rendered).not.toContain("/Users/private/path");
      expect(rendered).not.toContain("sensitive raw memory");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("reports a failed Phase 2 job as due after retry_at without changing retry_remaining", async () => {
    const home = await mkdtemp(join(tmpdir(), "floral-native-memory-retry-due-"));
    try {
      const db = new Database(join(home, "memories_1.sqlite"));
      db.exec(`
        CREATE TABLE jobs (
          kind TEXT NOT NULL,
          job_key TEXT NOT NULL,
          status TEXT NOT NULL,
          retry_remaining INTEGER,
          retry_at INTEGER,
          last_error TEXT
        );
        INSERT INTO jobs(kind, job_key, status, retry_remaining, retry_at, last_error)
          VALUES ('memory_consolidate_global', 'global', 'error', 2, 1786208257, 'failed_invalid_artifacts');
      `);
      db.close();

      const result = await readCodexNativeMemoryPhase2Diagnostics({
        managedHome: home,
        runtime: generatedRuntime(),
        nowMs: 1_786_208_258_000,
      });
      expect(result.phase2RetryState).toBe("due");
      expect(result.phase2RetryWaitSeconds).toBeUndefined();
      expect(result.phase2RetryRemaining).toBe(2);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("requires the exact upstream consolidation artifact pair and v1 summary schema", async () => {
    const home = await mkdtemp(join(tmpdir(), "floral-native-memory-summary-"));
    try {
      const memories = join(home, "memories");
      await mkdir(memories, { recursive: true });

      const incomplete = await readCodexNativeMemoryPhase2Diagnostics({
        managedHome: home,
        runtime: generatedRuntime(),
      });
      expect(incomplete.artifactContract).toBe("not-yet");
      expect(incomplete.diagnosis).not.toBe("consolidated");

      const runtime: CodexNativeMemoryRuntimeStatus = {
        ...generatedRuntime(),
        memoryIndex: "present",
        memorySummary: "present",
        memorySummarySchema: "v1",
        memoryIndexBytes: 50,
        memorySummaryBytes: 40,
        lifecycle: "consolidated",
      };
      const valid = await readCodexNativeMemoryPhase2Diagnostics({
        managedHome: home,
        runtime,
      });
      expect(valid.artifactContract).toBe("valid");
      expect(valid.diagnosis).toBe("consolidated");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("maps Codex failed_invalid_artifacts to the bounded artifacts category", () => {
    expect(classifyMemoryJobError("failed_invalid_artifacts")).toBe("artifacts");
  });



  it("recognizes the observed failed_invalid_artifacts Phase 2 outcome", async () => {
    const home = await mkdtemp(join(tmpdir(), "floral-native-memory-invalid-artifacts-"));
    try {
      const memories = join(home, "memories");
      await mkdir(memories, { recursive: true });
      await writeFile(join(memories, "raw_memories.md"), "private raw memory", "utf8");

      const db = new Database(join(home, "memories_1.sqlite"));
      db.exec(`
        CREATE TABLE jobs (
          kind TEXT NOT NULL,
          job_key TEXT NOT NULL,
          status TEXT NOT NULL,
          retry_remaining INTEGER,
          last_error TEXT
        );
        INSERT INTO jobs(kind, job_key, status, retry_remaining, last_error)
          VALUES ('memory_consolidate_global', 'global', 'error', 2, 'failed_invalid_artifacts');
      `);
      db.close();

      const result = await readCodexNativeMemoryPhase2Diagnostics({
        managedHome: home,
        runtime: generatedRuntime(),
      });
      expect(result).toMatchObject({
        phase2Status: "error",
        phase2ErrorClass: "artifacts",
        artifactContract: "invalid",
        memoryIndex: "absent",
        memorySummary: "absent",
        memorySummarySchema: "absent",
        diagnosis: "blocked:artifacts",
      });
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
