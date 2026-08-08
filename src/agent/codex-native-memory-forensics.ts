import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

interface SqliteStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface ReadonlySqliteDatabase {
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export interface CodexNativeMemoryPhase2Forensics {
  database: "absent" | "read-only" | "schema-unsupported" | "unavailable";
  databaseFile?: string;
  jobColumns: string[];
  status?: string;
  retryRemaining?: number;
  attempts?: number;
  createdAt?: string;
  updatedAt?: string;
  nextRetryAt?: string;
  errorPresent: boolean;
  errorLength?: number;
  errorFingerprint?: string;
  errorExcerpt?: string;
}

interface Candidate {
  path: string;
  mtimeMs: number;
}

const SAFE_JOB_METADATA_COLUMNS = [
  "status",
  "retry_remaining",
  "attempts",
  "attempt_count",
  "created_at",
  "updated_at",
  "next_retry_at",
  "retry_at",
  "last_error",
] as const;

export async function readCodexNativeMemoryPhase2Forensics(input: {
  managedHome: string;
}): Promise<CodexNativeMemoryPhase2Forensics> {
  const candidates = await discoverCandidates(resolve(input.managedHome));
  if (candidates.length === 0) {
    return {
      database: "absent",
      jobColumns: [],
      errorPresent: false,
    };
  }

  let openFailures = 0;
  let schemaSeen = false;
  for (const candidate of candidates) {
    try {
      const result = await inspectDatabase(candidate.path);
      if (!result) continue;
      schemaSeen = true;
      return {
        database: "read-only",
        databaseFile: basename(candidate.path),
        ...result,
      };
    } catch {
      openFailures += 1;
    }
  }

  return {
    database: openFailures === candidates.length
      ? "unavailable"
      : schemaSeen
        ? "read-only"
        : "schema-unsupported",
    jobColumns: [],
    errorPresent: false,
  };
}

export function renderCodexNativeMemoryPhase2ForensicLines(
  forensic: CodexNativeMemoryPhase2Forensics,
): string[] {
  return [
    `codex_memory_forensic_database=${forensic.database}`,
    `codex_memory_forensic_database_file=${forensic.databaseFile ?? "none"}`,
    `codex_memory_forensic_job_columns=${forensic.jobColumns.length > 0 ? forensic.jobColumns.join(",") : "none"}`,
    `codex_memory_forensic_status=${forensic.status ?? "unknown"}`,
    `codex_memory_forensic_retry_remaining=${forensic.retryRemaining ?? "unknown"}`,
    `codex_memory_forensic_attempts=${forensic.attempts ?? "unknown"}`,
    `codex_memory_forensic_created_at=${forensic.createdAt ?? "unknown"}`,
    `codex_memory_forensic_updated_at=${forensic.updatedAt ?? "unknown"}`,
    `codex_memory_forensic_next_retry_at=${forensic.nextRetryAt ?? "unknown"}`,
    `codex_memory_forensic_error_present=${forensic.errorPresent}`,
    `codex_memory_forensic_error_length=${forensic.errorLength ?? 0}`,
    `codex_memory_forensic_error_fingerprint=${forensic.errorFingerprint ?? "none"}`,
    `codex_memory_forensic_error_excerpt=${forensic.errorExcerpt ?? "none"}`,
  ];
}

export function redactNativeMemoryErrorExcerpt(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) return undefined;

  let text = normalized
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/giu, "Bearer <redacted>")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, "<redacted-secret>")
    .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/giu, "$1=<redacted>")
    .replace(/https?:\/\/[^\s)}>'"]+/giu, "<redacted-url>")
    .replace(/\/Users\/[^/\s]+/gu, "$HOME")
    .replace(/\/Volumes\/[^/\s]+/gu, "$VOLUME")
    .replace(/[A-Z]:\\Users\\[^\\\s]+/giu, "$HOME")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "<redacted-email>")
    .replace(/(["'`])[^"'`]{96,}\1/gu, "$1<redacted-long-quoted-text>$1");

  if (text.length > 600) text = `${text.slice(0, 600)}…`;
  return text;
}

export function fingerprintNativeMemoryError(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16)}`;
}

async function discoverCandidates(codexHome: string): Promise<Candidate[]> {
  let entries;
  try {
    entries = await readdir(codexHome, { withFileTypes: true });
  } catch {
    return [];
  }

  const candidates: Candidate[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/^(?:state|memories)_\d+\.sqlite$/u.test(entry.name)) continue;
    const path = join(codexHome, entry.name);
    try {
      const stat = await lstat(path);
      if (!stat.isFile()) continue;
      candidates.push({ path, mtimeMs: stat.mtimeMs });
    } catch {
      // Best-effort read-only diagnostics only.
    }
    if (candidates.length >= 8) break;
  }
  return candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function inspectDatabase(path: string): Promise<Omit<CodexNativeMemoryPhase2Forensics, "database" | "databaseFile"> | undefined> {
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
    if (!tables.has("jobs")) return undefined;

    const columns = readColumns(db, "jobs");
    if (!columns.has("kind")) return undefined;
    const selected = SAFE_JOB_METADATA_COLUMNS.filter((column) => columns.has(column));
    if (selected.length === 0) return undefined;

    const where = columns.has("job_key") ? "kind = ? AND job_key = ?" : "kind = ?";
    const row = db.prepare(
      `SELECT ${selected.join(", ")} FROM jobs WHERE ${where} LIMIT 1`,
    ).get(...(columns.has("job_key")
      ? ["memory_consolidate_global", "global"]
      : ["memory_consolidate_global"])) as Record<string, unknown> | undefined;
    if (!row) {
      return {
        jobColumns: [...columns].sort(),
        errorPresent: false,
      };
    }

    const lastError = row.last_error;
    const retryRemaining = numeric(row.retry_remaining);
    const attempts = numeric(row.attempts) ?? numeric(row.attempt_count);
    const nextRetryAt = stringValue(row.next_retry_at) ?? stringValue(row.retry_at);
    const errorText = typeof lastError === "string" ? lastError : undefined;

    return {
      jobColumns: [...columns].sort(),
      ...(stringValue(row.status) ? { status: stringValue(row.status)! } : {}),
      ...(retryRemaining !== undefined ? { retryRemaining } : {}),
      ...(attempts !== undefined ? { attempts } : {}),
      ...(stringValue(row.created_at) ? { createdAt: stringValue(row.created_at)! } : {}),
      ...(stringValue(row.updated_at) ? { updatedAt: stringValue(row.updated_at)! } : {}),
      ...(nextRetryAt ? { nextRetryAt } : {}),
      errorPresent: Boolean(errorText?.trim()),
      ...(errorText ? { errorLength: errorText.length } : {}),
      ...(fingerprintNativeMemoryError(errorText)
        ? { errorFingerprint: fingerprintNativeMemoryError(errorText)! }
        : {}),
      ...(redactNativeMemoryErrorExcerpt(errorText)
        ? { errorExcerpt: redactNativeMemoryErrorExcerpt(errorText)! }
        : {}),
    };
  } finally {
    db.close();
  }
}

function readColumns(db: ReadonlySqliteDatabase, table: "jobs"): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>)
      .map((row) => typeof row.name === "string" ? row.name : "")
      .filter(Boolean),
  );
}

function numeric(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
