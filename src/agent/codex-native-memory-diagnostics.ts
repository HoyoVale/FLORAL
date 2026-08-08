import { lstat, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { CodexNativeMemoryRuntimeStatus } from "./codex-native-memory-status.js";

interface SqliteStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface ReadonlySqliteDatabase {
  prepare(sql: string): SqliteStatement;
  close(): void;
}

type ErrorClass =
  | "none"
  | "sandbox"
  | "timeout"
  | "context-window"
  | "provider"
  | "filesystem-permission"
  | "process"
  | "artifacts"
  | "unknown";

export type CodexNativeMemoryPhase2Status =
  | "not-observed"
  | "pending"
  | "running"
  | "done"
  | "error"
  | "unknown";

export interface CodexNativeMemoryPhase2Diagnostics {
  database: "absent" | "read-only" | "schema-unsupported" | "unavailable";
  databaseFile?: string;
  stage1Outputs?: number;
  stage1SelectedForPhase2?: number;
  stage1JobsDone?: number;
  stage1JobsError?: number;
  stage1JobsPending?: number;
  stage1JobsRunning?: number;
  phase2Job: "present" | "absent" | "unknown";
  phase2Status: CodexNativeMemoryPhase2Status;
  phase2RetryRemaining?: number;
  phase2StartedAt?: string;
  phase2FinishedAt?: string;
  phase2RetryAt?: string;
  phase2RetryState: "not-applicable" | "backoff" | "due" | "exhausted" | "unknown";
  phase2RetryWaitSeconds?: number;
  phase2InputWatermark?: string;
  phase2LastSuccessWatermark?: string;
  phase2ErrorClass: ErrorClass;
  phase2WorkspaceDiff: "present" | "absent";
  memoryGitBaseline: "present" | "absent";
  memoryIndex: "present" | "absent";
  memorySummary: "present" | "absent";
  memorySummarySchema: "v1" | "invalid" | "unreadable" | "absent";
  artifactContract: "valid" | "invalid" | "not-yet";
  diagnosis: string;
}

interface JobRow {
  status?: unknown;
  retry_remaining?: unknown;
  started_at?: unknown;
  finished_at?: unknown;
  retry_at?: unknown;
  input_watermark?: unknown;
  last_success_watermark?: unknown;
  last_error?: unknown;
}

interface CandidateObservation {
  file: string;
  mtimeMs: number;
  hasRelevantSchema: boolean;
  stage1Outputs?: number;
  stage1SelectedForPhase2?: number;
  stage1JobsDone?: number;
  stage1JobsError?: number;
  stage1JobsPending?: number;
  stage1JobsRunning?: number;
  phase2Job?: JobRow;
}

export async function readCodexNativeMemoryPhase2Diagnostics(input: {
  managedHome: string;
  runtime: CodexNativeMemoryRuntimeStatus;
  nowMs?: number;
}): Promise<CodexNativeMemoryPhase2Diagnostics> {
  const codexHome = resolve(input.managedHome);
  const memoriesRoot = join(codexHome, "memories");
  const [phase2WorkspaceDiff, memoryGitBaseline] = await Promise.all([
    regularFileExists(join(memoriesRoot, "phase2_workspace_diff.md")),
    directoryExists(join(memoriesRoot, ".git")),
  ]);
  const memoryIndex = input.runtime.memoryIndex;
  const memorySummary = input.runtime.memorySummary ?? "absent";
  const memorySummarySchema = input.runtime.memorySummarySchema ?? "absent";
  const artifactContract = classifyArtifactContract({
    memoryIndex,
    memorySummary,
    memorySummarySchema,
  });

  const candidates = await discoverDatabaseCandidates(codexHome);
  if (candidates.length === 0) {
    return finalize({
      database: "absent",
      phase2Job: "unknown",
      phase2Status: "not-observed",
      phase2RetryState: "unknown",
      phase2ErrorClass: "none",
      phase2WorkspaceDiff,
      memoryGitBaseline,
      memoryIndex,
      memorySummary,
      memorySummarySchema,
      artifactContract,
    }, input.runtime);
  }

  const observations: CandidateObservation[] = [];
  let openFailures = 0;
  for (const candidate of candidates) {
    try {
      observations.push(await inspectCandidateDatabase(candidate.path, candidate.mtimeMs));
    } catch {
      openFailures += 1;
    }
  }

  const relevant = observations
    .filter((item) => item.hasRelevantSchema)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (relevant.length === 0) {
    return finalize({
      database: openFailures === candidates.length ? "unavailable" : "schema-unsupported",
      phase2Job: "unknown",
      phase2Status: "not-observed",
      phase2RetryState: "unknown",
      phase2ErrorClass: "none",
      phase2WorkspaceDiff,
      memoryGitBaseline,
      memoryIndex,
      memorySummary,
      memorySummarySchema,
      artifactContract,
    }, input.runtime);
  }

  const selected = relevant.find((item) => item.phase2Job) ?? relevant[0]!;
  const phase2Status = normalizeJobStatus(selected.phase2Job?.status);
  const phase2ErrorClass = selected.phase2Job
    ? classifyMemoryJobError(selected.phase2Job.last_error)
    : "none";
  const retryRemaining = numericValue(selected.phase2Job?.retry_remaining);
  const startedAt = timestampValue(selected.phase2Job?.started_at);
  const finishedAt = timestampValue(selected.phase2Job?.finished_at);
  const retryAt = timestampMetadata(selected.phase2Job?.retry_at);
  const nowMs = input.nowMs ?? Date.now();
  const retryState = classifyRetryState({
    status: phase2Status,
    ...(retryRemaining !== undefined ? { retryRemaining } : {}),
    ...(retryAt ? { retryAtMs: retryAt.ms } : {}),
    nowMs,
  });
  const retryWaitSeconds = retryState === "backoff" && retryAt
    ? Math.max(0, Math.ceil((retryAt.ms - nowMs) / 1_000))
    : undefined;

  return finalize({
    database: "read-only",
    databaseFile: selected.file,
    ...(selected.stage1Outputs !== undefined ? { stage1Outputs: selected.stage1Outputs } : {}),
    ...(selected.stage1SelectedForPhase2 !== undefined
      ? { stage1SelectedForPhase2: selected.stage1SelectedForPhase2 }
      : {}),
    ...(selected.stage1JobsDone !== undefined ? { stage1JobsDone: selected.stage1JobsDone } : {}),
    ...(selected.stage1JobsError !== undefined ? { stage1JobsError: selected.stage1JobsError } : {}),
    ...(selected.stage1JobsPending !== undefined ? { stage1JobsPending: selected.stage1JobsPending } : {}),
    ...(selected.stage1JobsRunning !== undefined ? { stage1JobsRunning: selected.stage1JobsRunning } : {}),
    phase2Job: selected.phase2Job ? "present" : "absent",
    phase2Status,
    ...(retryRemaining !== undefined ? { phase2RetryRemaining: retryRemaining } : {}),
    ...(startedAt ? { phase2StartedAt: startedAt } : {}),
    ...(finishedAt ? { phase2FinishedAt: finishedAt } : {}),
    ...(retryAt?.iso ? { phase2RetryAt: retryAt.iso } : {}),
    phase2RetryState: retryState,
    ...(retryWaitSeconds !== undefined ? { phase2RetryWaitSeconds: retryWaitSeconds } : {}),
    ...(metadataScalar(selected.phase2Job?.input_watermark)
      ? { phase2InputWatermark: metadataScalar(selected.phase2Job?.input_watermark)! }
      : {}),
    ...(metadataScalar(selected.phase2Job?.last_success_watermark)
      ? { phase2LastSuccessWatermark: metadataScalar(selected.phase2Job?.last_success_watermark)! }
      : {}),
    phase2ErrorClass,
    phase2WorkspaceDiff,
    memoryGitBaseline,
    memoryIndex,
    memorySummary,
    memorySummarySchema,
    artifactContract: phase2ErrorClass === "artifacts" ? "invalid" : artifactContract,
  }, input.runtime);
}

export function renderCodexNativeMemoryPhase2DiagnosticLines(
  diagnostic: CodexNativeMemoryPhase2Diagnostics,
): string[] {
  return [
    `codex_memory_phase2_database=${diagnostic.database}`,
    `codex_memory_phase2_database_file=${diagnostic.databaseFile ?? "none"}`,
    `codex_memory_stage1_outputs=${diagnostic.stage1Outputs ?? "unknown"}`,
    `codex_memory_stage1_selected_for_phase2=${diagnostic.stage1SelectedForPhase2 ?? "unknown"}`,
    `codex_memory_stage1_jobs_done=${diagnostic.stage1JobsDone ?? "unknown"}`,
    `codex_memory_stage1_jobs_error=${diagnostic.stage1JobsError ?? "unknown"}`,
    `codex_memory_stage1_jobs_pending=${diagnostic.stage1JobsPending ?? "unknown"}`,
    `codex_memory_stage1_jobs_running=${diagnostic.stage1JobsRunning ?? "unknown"}`,
    `codex_memory_phase2_job=${diagnostic.phase2Job}`,
    `codex_memory_phase2_status=${diagnostic.phase2Status}`,
    `codex_memory_phase2_retry_remaining=${diagnostic.phase2RetryRemaining ?? "unknown"}`,
    `codex_memory_phase2_started_at=${diagnostic.phase2StartedAt ?? "unknown"}`,
    `codex_memory_phase2_finished_at=${diagnostic.phase2FinishedAt ?? "unknown"}`,
    `codex_memory_phase2_retry_at=${diagnostic.phase2RetryAt ?? "unknown"}`,
    `codex_memory_phase2_retry_state=${diagnostic.phase2RetryState}`,
    `codex_memory_phase2_retry_wait_seconds=${diagnostic.phase2RetryWaitSeconds ?? 0}`,
    `codex_memory_phase2_input_watermark=${diagnostic.phase2InputWatermark ?? "unknown"}`,
    `codex_memory_phase2_last_success_watermark=${diagnostic.phase2LastSuccessWatermark ?? "unknown"}`,
    `codex_memory_phase2_error_class=${diagnostic.phase2ErrorClass}`,
    `codex_memory_phase2_workspace_diff=${diagnostic.phase2WorkspaceDiff}`,
    `codex_memory_phase2_git_baseline=${diagnostic.memoryGitBaseline}`,
    `codex_memory_index=${diagnostic.memoryIndex}`,
    `codex_memory_summary=${diagnostic.memorySummary}`,
    `codex_memory_summary_schema=${diagnostic.memorySummarySchema}`,
    `codex_memory_artifact_contract=${diagnostic.artifactContract}`,
    `codex_memory_phase2_diagnosis=${diagnostic.diagnosis}`,
  ];
}

export function classifyMemoryJobError(value: unknown): ErrorClass {
  if (typeof value !== "string" || !value.trim()) return "none";
  const text = value.toLowerCase();
  if (/sandbox-exec|sandbox_apply|seatbelt|operation not permitted|sandbox/.test(text)) {
    return "sandbox";
  }
  if (/context[_ -]?length|context window|ran out of room/.test(text)) {
    return "context-window";
  }
  if (/timeout|timed out|waiting for child process/.test(text)) return "timeout";
  if (/permission denied|eacces|eperm|read-only file system|access denied/.test(text)) {
    return "filesystem-permission";
  }
  if (/provider|responses|http|connection|network|api|model/.test(text)) return "provider";
  if (/failed_invalid_artifacts|invalid[_ -]?artifacts|consolidation artifacts are invalid/.test(text)) {
    return "artifacts";
  }
  if (/spawn|child process|process exited|exit code|signal/.test(text)) return "process";
  return "unknown";
}


export function classifyArtifactContract(input: {
  memoryIndex: "present" | "absent";
  memorySummary: "present" | "absent";
  memorySummarySchema: "v1" | "invalid" | "unreadable" | "absent";
}): "valid" | "invalid" | "not-yet" {
  if (
    input.memoryIndex === "present"
    && input.memorySummary === "present"
    && input.memorySummarySchema === "v1"
  ) return "valid";
  if (input.memoryIndex === "present" || input.memorySummary === "present") return "invalid";
  return "not-yet";
}

function finalize(
  diagnostic: Omit<CodexNativeMemoryPhase2Diagnostics, "diagnosis">,
  runtime: CodexNativeMemoryRuntimeStatus,
): CodexNativeMemoryPhase2Diagnostics {
  return {
    ...diagnostic,
    diagnosis: diagnosePhase2(diagnostic, runtime),
  };
}

function diagnosePhase2(
  diagnostic: Omit<CodexNativeMemoryPhase2Diagnostics, "diagnosis">,
  runtime: CodexNativeMemoryRuntimeStatus,
): string {
  if (!runtime.effective) return "inactive";
  if (runtime.lifecycle === "consolidated" && diagnostic.artifactContract === "valid") {
    return "consolidated";
  }
  if (runtime.lifecycle === "armed") return "waiting:phase1";
  if (diagnostic.database === "absent") return "blocked:database-absent";
  if (diagnostic.database === "unavailable") return "blocked:database-unavailable";
  if (diagnostic.database === "schema-unsupported") return "unknown:schema-unsupported";
  if (diagnostic.phase2Job === "absent") return "blocked:phase2-job-not-observed";
  if (diagnostic.phase2Status === "error") {
    const reason = diagnostic.phase2ErrorClass === "none" ? "unknown" : diagnostic.phase2ErrorClass;
    if (diagnostic.phase2RetryState === "backoff") return `waiting:phase2-backoff:${reason}`;
    if (diagnostic.phase2RetryState === "due") return `blocked:${reason}:retry-due`;
    if (diagnostic.phase2RetryState === "exhausted") return `blocked:${reason}:retry-exhausted`;
    return `blocked:${reason}`;
  }
  if (diagnostic.phase2Status === "pending") return "waiting:phase2-pending";
  if (diagnostic.phase2Status === "running") return "running:phase2";
  if (diagnostic.phase2Status === "done") return "blocked:done-without-consolidated-artifact";
  return "unknown:phase2-status";
}

async function discoverDatabaseCandidates(
  codexHome: string,
): Promise<Array<{ path: string; mtimeMs: number }>> {
  let entries;
  try {
    entries = await readdir(codexHome, { withFileTypes: true });
  } catch {
    return [];
  }
  const results: Array<{ path: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/^(?:state|memories)_\d+\.sqlite$/u.test(entry.name)) continue;
    const path = join(codexHome, entry.name);
    try {
      const metadata = await lstat(path);
      if (!metadata.isFile()) continue;
      results.push({ path, mtimeMs: metadata.mtimeMs });
    } catch {
      // Ignore races; diagnostics are best-effort and read-only.
    }
    if (results.length >= 8) break;
  }
  return results.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function inspectCandidateDatabase(
  path: string,
  mtimeMs: number,
): Promise<CandidateObservation> {
  const packageName = "better-sqlite3";
  const module = await import(packageName) as {
    default: new (
      path: string,
      options: { readonly: boolean; fileMustExist: boolean },
    ) => ReadonlySqliteDatabase;
  };
  const db = new module.default(path, { readonly: true, fileMustExist: true });
  try {
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name?: unknown }>)
        .map((row) => typeof row.name === "string" ? row.name : "")
        .filter(Boolean),
    );
    const hasJobs = tables.has("jobs");
    const hasStage1 = tables.has("stage1_outputs");
    const observation: CandidateObservation = {
      file: basename(path),
      mtimeMs,
      hasRelevantSchema: hasJobs || hasStage1,
    };

    if (hasStage1) {
      const columns = readTableColumns(db, "stage1_outputs");
      const countRow = db.prepare("SELECT COUNT(*) AS count FROM stage1_outputs").get() as { count?: unknown } | undefined;
      const count = numericValue(countRow?.count);
      if (count !== undefined) observation.stage1Outputs = count;
      if (columns.has("selected_for_phase2")) {
        const selectedRow = db.prepare(
          "SELECT COUNT(*) AS count FROM stage1_outputs WHERE selected_for_phase2 = 1",
        ).get() as { count?: unknown } | undefined;
        const selected = numericValue(selectedRow?.count);
        if (selected !== undefined) observation.stage1SelectedForPhase2 = selected;
      }
    }

    if (hasJobs) {
      const columns = readTableColumns(db, "jobs");
      if (columns.has("kind") && columns.has("status")) {
        const grouped = db.prepare(
          "SELECT status, COUNT(*) AS count FROM jobs WHERE kind = ? GROUP BY status",
        ).all("memory_stage1") as Array<{ status?: unknown; count?: unknown }>;
        let done = 0;
        let error = 0;
        let pending = 0;
        let running = 0;
        for (const row of grouped) {
          const count = numericValue(row.count) ?? 0;
          switch (normalizeJobStatus(row.status)) {
            case "done": done += count; break;
            case "error": error += count; break;
            case "pending": pending += count; break;
            case "running": running += count; break;
            default: break;
          }
        }
        observation.stage1JobsDone = done;
        observation.stage1JobsError = error;
        observation.stage1JobsPending = pending;
        observation.stage1JobsRunning = running;

        const selectedColumns = [
          "status",
          "retry_remaining",
          "started_at",
          "finished_at",
          "retry_at",
          "input_watermark",
          "last_success_watermark",
          "last_error",
        ].filter((column) => columns.has(column));
        if (selectedColumns.length > 0) {
          const where = columns.has("job_key")
            ? "kind = ? AND job_key = ?"
            : "kind = ?";
          const row = db.prepare(
            `SELECT ${selectedColumns.join(", ")} FROM jobs WHERE ${where} LIMIT 1`,
          ).get(...(columns.has("job_key")
            ? ["memory_consolidate_global", "global"]
            : ["memory_consolidate_global"])) as JobRow | undefined;
          if (row) observation.phase2Job = row;
        }
      }
    }

    return observation;
  } finally {
    db.close();
  }
}

function readTableColumns(db: ReadonlySqliteDatabase, table: "jobs" | "stage1_outputs"): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>)
      .map((row) => typeof row.name === "string" ? row.name : "")
      .filter(Boolean),
  );
}

function normalizeJobStatus(value: unknown): CodexNativeMemoryPhase2Status {
  if (typeof value !== "string") return "unknown";
  const status = value.trim().toLowerCase();
  if (["done", "success", "succeeded", "completed"].includes(status)) return "done";
  if (["error", "failed", "failure"].includes(status)) return "error";
  if (["pending", "waiting", "retry", "queued"].includes(status)) return "pending";
  if (["running", "claimed", "in_progress", "in-progress", "leased"].includes(status)) return "running";
  return "unknown";
}

function numericValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  return undefined;
}

async function regularFileExists(path: string): Promise<"present" | "absent"> {
  try {
    const metadata = await lstat(path);
    return metadata.isFile() ? "present" : "absent";
  } catch {
    return "absent";
  }
}

async function directoryExists(path: string): Promise<"present" | "absent"> {
  try {
    const metadata = await lstat(path);
    return metadata.isDirectory() ? "present" : "absent";
  } catch {
    return "absent";
  }
}

function timestampMetadata(value: unknown): { iso: string; ms: number } | undefined {
  let ms: number | undefined;
  if (typeof value === "number" && Number.isFinite(value)) {
    ms = Math.abs(value) < 100_000_000_000 ? value * 1_000 : value;
  } else if (typeof value === "bigint") {
    const numericValue = Number(value);
    if (Number.isFinite(numericValue)) {
      ms = Math.abs(numericValue) < 100_000_000_000 ? numericValue * 1_000 : numericValue;
    }
  } else if (typeof value === "string" && value.trim()) {
    const trimmed = value.trim();
    const asNumber = Number(trimmed);
    if (Number.isFinite(asNumber)) {
      ms = Math.abs(asNumber) < 100_000_000_000 ? asNumber * 1_000 : asNumber;
    } else {
      const parsed = Date.parse(trimmed);
      if (Number.isFinite(parsed)) ms = parsed;
    }
  }
  if (ms === undefined) return undefined;
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return undefined;
  return { iso: date.toISOString(), ms };
}

function timestampValue(value: unknown): string | undefined {
  return timestampMetadata(value)?.iso;
}

function metadataScalar(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string" && value.trim()) return value.trim().slice(0, 80);
  return undefined;
}

function classifyRetryState(input: {
  status: CodexNativeMemoryPhase2Status;
  retryRemaining?: number;
  retryAtMs?: number;
  nowMs: number;
}): CodexNativeMemoryPhase2Diagnostics["phase2RetryState"] {
  if (input.status !== "error") return "not-applicable";
  if (input.retryRemaining !== undefined && input.retryRemaining <= 0) return "exhausted";
  if (input.retryAtMs === undefined) return "unknown";
  return input.retryAtMs <= input.nowMs ? "due" : "backoff";
}
