import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { WorkspaceProject } from "./project-workspace.js";

const CONTEXT_DIRECTORY = ".floral";
const LEDGER_DIRECTORY = "context-ledger";
const LEDGER_SCHEMA_VERSION = 1 as const;

export type ProjectContextLedgerTarget = "context" | "decision" | "issue" | "agents";
export type ProjectContextLedgerStatus = "active" | "stale" | "superseded" | "resolved" | "archived";
export type ProjectContextLedgerSource = "owner-command" | "agent-proposal" | "verified-contract";

export interface ProjectContextLedgerEntry {
  schemaVersion: typeof LEDGER_SCHEMA_VERSION;
  id: string;
  target: ProjectContextLedgerTarget;
  contentHash: string;
  source: ProjectContextLedgerSource;
  evidenceRefs: string[];
  createdAt: string;
  updatedAt: string;
  verifiedAt?: string | undefined;
  status: ProjectContextLedgerStatus;
  supersedes?: string | undefined;
}

export interface RecordProjectContextLedgerEntryInput {
  target: ProjectContextLedgerTarget;
  contentHash: string;
  source: ProjectContextLedgerSource;
  evidenceRefs?: readonly string[] | undefined;
  now?: Date | undefined;
}

/**
 * Records provenance metadata beside project context without duplicating the
 * context body. One deterministic entry file per content hash avoids a shared
 * append file and therefore avoids silently losing concurrent writes.
 */
export async function recordProjectContextLedgerEntry(
  project: WorkspaceProject,
  input: RecordProjectContextLedgerEntryInput,
): Promise<ProjectContextLedgerEntry> {
  const canonicalProject = await canonicalProjectDirectory(project);
  const canonicalContext = await canonicalContextDirectory(canonicalProject);
  const ledgerDirectory = await ensureLedgerDirectory(canonicalContext);
  const contentHash = readContentHash(input.contentHash);
  const target = readEnum(input.target, "target", ["context", "decision", "issue", "agents"] as const);
  const source = readEnum(input.source, "source", ["owner-command", "agent-proposal", "verified-contract"] as const);
  const evidenceRefs = normalizeEvidenceRefs(input.evidenceRefs ?? []);
  const id = createHash("sha256")
    .update(`${canonicalProject}\u0000${target}\u0000${contentHash}`, "utf8")
    .digest("hex")
    .slice(0, 32);
  const path = join(ledgerDirectory, `${id}.json`);
  const existing = await readLedgerEntry(path, ledgerDirectory).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (existing) {
    if (existing.target !== target || existing.contentHash !== contentHash) {
      throw new Error("Project context ledger entry fingerprint collision");
    }
    if (existing.status === "stale") {
      const timestamp = (input.now ?? new Date()).toISOString();
      const reactivated: ProjectContextLedgerEntry = {
        ...existing,
        status: "active",
        updatedAt: timestamp,
        verifiedAt: timestamp,
      };
      await replacePrivateJson(path, reactivated);
      return reactivated;
    }
    return existing;
  }

  const timestamp = (input.now ?? new Date()).toISOString();
  const entry: ProjectContextLedgerEntry = {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    id,
    target,
    contentHash,
    source,
    evidenceRefs,
    createdAt: timestamp,
    updatedAt: timestamp,
    status: "active",
  };
  await writeNewPrivateJson(path, entry);
  return entry;
}

export async function listProjectContextLedgerEntries(
  project: WorkspaceProject,
): Promise<ProjectContextLedgerEntry[]> {
  const canonicalProject = await canonicalProjectDirectory(project);
  const canonicalContext = await canonicalContextDirectory(canonicalProject);
  const ledgerDirectory = join(canonicalContext, LEDGER_DIRECTORY);
  const stat = await lstat(ledgerDirectory).catch(() => undefined);
  if (!stat) return [];
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(".floral/context-ledger must be a real directory");
  }
  const canonicalLedger = await realpath(ledgerDirectory);
  if (dirname(canonicalLedger) !== canonicalContext) {
    throw new Error(".floral/context-ledger resolves outside .floral");
  }
  const entries = await readdir(canonicalLedger, { withFileTypes: true });
  const output: ProjectContextLedgerEntry[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^[a-f0-9]{32}\.json$/u.test(entry.name)) continue;
    output.push(await readLedgerEntry(join(canonicalLedger, entry.name), canonicalLedger));
  }
  return output.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export async function updateProjectContextLedgerEntry(
  project: WorkspaceProject,
  entryId: string,
  input: {
    status?: ProjectContextLedgerStatus | undefined;
    verifiedAt?: Date | undefined;
  },
): Promise<ProjectContextLedgerEntry> {
  const canonicalProject = await canonicalProjectDirectory(project);
  const canonicalContext = await canonicalContextDirectory(canonicalProject);
  const ledgerDirectory = join(canonicalContext, LEDGER_DIRECTORY);
  const canonicalLedger = await realpath(ledgerDirectory);
  if (dirname(canonicalLedger) !== canonicalContext) {
    throw new Error(".floral/context-ledger resolves outside .floral");
  }
  const id = readToken(entryId, "id", /^[a-f0-9]{32}$/u);
  const path = join(canonicalLedger, `${id}.json`);
  const current = await readLedgerEntry(path, canonicalLedger);
  const timestamp = (input.verifiedAt ?? new Date()).toISOString();
  const next: ProjectContextLedgerEntry = {
    ...current,
    status: input.status ?? current.status,
    updatedAt: timestamp,
    verifiedAt: timestamp,
  };
  await replacePrivateJson(path, next);
  return next;
}

async function canonicalProjectDirectory(project: WorkspaceProject): Promise<string> {
  const absolute = resolve(project.path);
  const stat = await lstat(absolute).catch(() => undefined);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Project context ledger requires a real project directory");
  }
  const canonical = await realpath(absolute);
  if (canonical !== absolute) {
    throw new Error("Project path must already be canonical");
  }
  return canonical;
}

async function canonicalContextDirectory(canonicalProject: string): Promise<string> {
  const contextDirectory = join(canonicalProject, CONTEXT_DIRECTORY);
  const stat = await lstat(contextDirectory).catch(() => undefined);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(".floral must be a real project-local directory");
  }
  const canonical = await realpath(contextDirectory);
  if (dirname(canonical) !== canonicalProject) {
    throw new Error(".floral resolves outside the project");
  }
  return canonical;
}

async function ensureLedgerDirectory(canonicalContext: string): Promise<string> {
  const ledgerDirectory = join(canonicalContext, LEDGER_DIRECTORY);
  const stat = await lstat(ledgerDirectory).catch(() => undefined);
  if (!stat) {
    await mkdir(ledgerDirectory, { recursive: false, mode: 0o700 });
  } else if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(".floral/context-ledger must be a real directory");
  }
  await chmod(ledgerDirectory, 0o700).catch(() => undefined);
  const canonical = await realpath(ledgerDirectory);
  if (dirname(canonical) !== canonicalContext) {
    throw new Error(".floral/context-ledger resolves outside .floral");
  }
  return canonical;
}

async function readLedgerEntry(
  path: string,
  expectedParent: string,
): Promise<ProjectContextLedgerEntry> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw new Error("Project context ledger entry must be a single-link regular file");
  }
  const canonical = await realpath(path);
  if (dirname(canonical) !== expectedParent) {
    throw new Error("Project context ledger entry resolves outside its ledger");
  }
  return parseLedgerEntry(JSON.parse(await readFile(path, "utf8")) as unknown);
}

async function writeNewPrivateJson(path: string, value: ProjectContextLedgerEntry): Promise<void> {
  const temporary = `${path}.tmp-${String(process.pid)}-${Date.now().toString(36)}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await chmod(temporary, 0o600).catch(() => undefined);
    await rename(temporary, path);
    await chmod(path, 0o600).catch(() => undefined);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function replacePrivateJson(path: string, value: ProjectContextLedgerEntry): Promise<void> {
  const temporary = `${path}.tmp-${String(process.pid)}-${Date.now().toString(36)}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await chmod(temporary, 0o600).catch(() => undefined);
    await rename(temporary, path);
    await chmod(path, 0o600).catch(() => undefined);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function parseLedgerEntry(value: unknown): ProjectContextLedgerEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Project context ledger entry is invalid");
  }
  const record = value as Record<string, unknown>;
  const id = readToken(record.id, "id", /^[a-f0-9]{32}$/u);
  const target = readEnum(record.target, "target", ["context", "decision", "issue", "agents"] as const);
  const contentHash = readContentHash(record.contentHash);
  const source = readEnum(record.source, "source", ["owner-command", "agent-proposal", "verified-contract"] as const);
  const status = readEnum(record.status, "status", ["active", "stale", "superseded", "resolved", "archived"] as const);
  const createdAt = readIsoTimestamp(record.createdAt, "createdAt");
  const updatedAt = readIsoTimestamp(record.updatedAt, "updatedAt");
  const evidenceRefs = normalizeEvidenceRefs(Array.isArray(record.evidenceRefs) ? record.evidenceRefs : []);
  const verifiedAt = record.verifiedAt === undefined ? undefined : readIsoTimestamp(record.verifiedAt, "verifiedAt");
  const supersedes = record.supersedes === undefined
    ? undefined
    : readToken(record.supersedes, "supersedes", /^[a-f0-9]{32}$/u);
  if (record.schemaVersion !== LEDGER_SCHEMA_VERSION) {
    throw new Error("Project context ledger schema is unsupported");
  }
  return {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    id,
    target,
    contentHash,
    source,
    evidenceRefs,
    createdAt,
    updatedAt,
    ...(verifiedAt ? { verifiedAt } : {}),
    status,
    ...(supersedes ? { supersedes } : {}),
  };
}

function readContentHash(value: unknown): string {
  return readToken(value, "contentHash", /^[a-f0-9]{64}$/u);
}

function readToken(value: unknown, name: string, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`Project context ledger ${name} is invalid`);
  }
  return value;
}

function readEnum<const T extends readonly string[]>(
  value: unknown,
  name: string,
  allowed: T,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`Project context ledger ${name} is invalid`);
  }
  return value as T[number];
}

function readIsoTimestamp(value: unknown, name: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`Project context ledger ${name} is invalid`);
  }
  return value;
}

function normalizeEvidenceRefs(values: readonly unknown[]): string[] {
  if (values.length > 16) throw new Error("Project context ledger has too many evidence references");
  const output = values.map((value) => {
    if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/u.test(value)) {
      throw new Error("Project context ledger evidence reference is invalid");
    }
    return value;
  });
  return [...new Set(output)].sort();
}
