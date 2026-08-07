import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type {
  AgentApprovalDecision,
  AgentApprovalRequest,
  GatewayRole,
} from "../core/types.js";

export interface LocalConfirmationScope {
  userId: string;
  role: GatewayRole;
  conversationId: string;
}

export interface LocalConfirmationNotice {
  publicId: string;
  capability: AgentApprovalRequest["capability"];
  summary: string;
  expiresAt: number;
  ttlMs: number;
}

export interface LocalConfirmationHandle {
  notice: LocalConfirmationNotice;
  decision: Promise<AgentApprovalDecision>;
}

export interface LocalConfirmationBrokerOptions {
  directory: string;
  ttlMs: number;
  pollIntervalMs: number;
  maxPending: number;
  enabled: boolean;
  now?: (() => number) | undefined;
  createPublicId?: (() => string) | undefined;
  createSessionId?: (() => string) | undefined;
}

interface PendingRecord {
  schemaVersion: 1;
  publicId: string;
  sessionId: string;
  createdAt: string;
  expiresAt: string;
  capability: AgentApprovalRequest["capability"];
  kind: AgentApprovalRequest["kind"];
  source: AgentApprovalRequest["source"];
  summary: string;
  conversationHash: string;
  requestFingerprint: string;
}

interface DecisionRecord {
  schemaVersion: 1;
  publicId: string;
  sessionId: string;
  requestFingerprint: string;
  decision: AgentApprovalDecision;
  decidedAt: string;
}

interface PendingState {
  record: PendingRecord;
  scope: LocalConfirmationScope;
  timer: NodeJS.Timeout;
  pollTimer: NodeJS.Timeout | undefined;
  resolve: (decision: AgentApprovalDecision) => void;
}

export class LocalConfirmationBroker {
  readonly #directory: string;
  readonly #now: () => number;
  readonly #createPublicId: () => string;
  readonly #sessionId: string;
  readonly #pending = new Map<string, PendingState>();
  #initialized = false;

  constructor(private readonly options: LocalConfirmationBrokerOptions) {
    if (!Number.isInteger(options.ttlMs) || options.ttlMs < 5_000) {
      throw new Error("Local approval TTL must be at least 5000 ms");
    }
    if (!Number.isInteger(options.pollIntervalMs) || options.pollIntervalMs < 50) {
      throw new Error("Local approval poll interval must be at least 50 ms");
    }
    if (!Number.isInteger(options.maxPending) || options.maxPending <= 0) {
      throw new Error("Local approval maxPending must be a positive integer");
    }
    this.#directory = resolve(options.directory);
    this.#now = options.now ?? Date.now;
    this.#createPublicId = options.createPublicId ?? (() => randomBytes(8).toString("hex").toUpperCase());
    this.#sessionId = (options.createSessionId ?? (() => randomBytes(16).toString("hex")))();
  }

  get directory(): string {
    return this.#directory;
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    await chmod(this.#directory, 0o700).catch(() => undefined);
    for (const name of await readdir(this.#directory)) {
      if (/^(pending|decision)-[A-Z0-9]{6,24}\.json$/u.test(name)) {
        await rm(join(this.#directory, name), { force: true });
      }
    }
    this.#initialized = true;
  }

  async request(
    scope: LocalConfirmationScope,
    request: AgentApprovalRequest,
  ): Promise<LocalConfirmationHandle | undefined> {
    if (!this.options.enabled) return undefined;
    await this.initialize();
    if (this.#pending.size >= this.options.maxPending) return undefined;

    const publicId = this.#uniquePublicId();
    const createdAtMs = this.#now();
    const expiresAtMs = createdAtMs + this.options.ttlMs;
    const record: PendingRecord = {
      schemaVersion: 1,
      publicId,
      sessionId: this.#sessionId,
      createdAt: new Date(createdAtMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      capability: request.capability,
      kind: request.kind,
      source: request.source,
      summary: sanitizeSummary(request.summary),
      conversationHash: sha256(scope.conversationId),
      requestFingerprint: fingerprintRequest(scope, request),
    };
    await writePrivateJson(this.#pendingPath(publicId), record);

    let resolveDecision!: (decision: AgentApprovalDecision) => void;
    const decision = new Promise<AgentApprovalDecision>((resolve) => {
      resolveDecision = resolve;
    });
    const timer = setTimeout(() => {
      void this.#finish(publicId, "deny");
    }, this.options.ttlMs);
    const state: PendingState = {
      record,
      scope,
      timer,
      pollTimer: undefined,
      resolve: resolveDecision,
    };
    this.#pending.set(publicId, state);
    this.#schedulePoll(publicId);

    return {
      notice: {
        publicId,
        capability: request.capability,
        summary: record.summary,
        expiresAt: expiresAtMs,
        ttlMs: this.options.ttlMs,
      },
      decision,
    };
  }

  pendingCount(conversationId?: string): number {
    if (!conversationId) return this.#pending.size;
    return [...this.#pending.values()].filter((pending) => pending.scope.conversationId === conversationId).length;
  }

  cancelConversation(conversationId: string): void {
    for (const [publicId, pending] of this.#pending) {
      if (pending.scope.conversationId !== conversationId) continue;
      void this.#finish(publicId, "deny");
    }
  }

  cancelAll(): void {
    for (const publicId of [...this.#pending.keys()]) {
      void this.#finish(publicId, "deny");
    }
  }

  async #poll(publicId: string): Promise<void> {
    const pending = this.#pending.get(publicId);
    if (!pending) return;
    if (this.#now() >= Date.parse(pending.record.expiresAt)) {
      await this.#finish(publicId, "deny");
      return;
    }

    try {
      const raw = JSON.parse(await readFile(this.#decisionPath(publicId), "utf8")) as Partial<DecisionRecord>;
      if (
        raw.schemaVersion === 1
        && raw.publicId === pending.record.publicId
        && raw.sessionId === pending.record.sessionId
        && raw.requestFingerprint === pending.record.requestFingerprint
        && (raw.decision === "approve" || raw.decision === "deny")
      ) {
        await this.#finish(publicId, raw.decision);
        return;
      }
      await rm(this.#decisionPath(publicId), { force: true }).catch(() => undefined);
    } catch (error) {
      if (!isFileMissing(error)) {
        await rm(this.#decisionPath(publicId), { force: true }).catch(() => undefined);
      }
    }
    this.#schedulePoll(publicId);
  }

  #schedulePoll(publicId: string): void {
    const pending = this.#pending.get(publicId);
    if (!pending) return;
    const timer = setTimeout(() => {
      void this.#poll(publicId);
    }, this.options.pollIntervalMs);
    pending.pollTimer = timer;
  }

  async #finish(publicId: string, decision: AgentApprovalDecision): Promise<void> {
    const pending = this.#pending.get(publicId);
    if (!pending) return;
    this.#pending.delete(publicId);
    clearTimeout(pending.timer);
    if (pending.pollTimer) clearTimeout(pending.pollTimer);
    await Promise.all([
      rm(this.#pendingPath(publicId), { force: true }),
      rm(this.#decisionPath(publicId), { force: true }),
    ]).catch(() => undefined);
    pending.resolve(decision);
  }

  #uniquePublicId(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const publicId = this.#createPublicId().trim().toUpperCase();
      if (!/^[A-Z0-9]{6,24}$/u.test(publicId)) {
        throw new Error("Local approval public ID generator returned an invalid value");
      }
      if (!this.#pending.has(publicId)) return publicId;
    }
    throw new Error("Unable to allocate a unique local approval ID");
  }

  #pendingPath(publicId: string): string {
    return join(this.#directory, `pending-${publicId}.json`);
  }

  #decisionPath(publicId: string): string {
    return join(this.#directory, `decision-${publicId}.json`);
  }
}

export async function listLocalApprovalRecords(
  directory: string,
  now = Date.now(),
): Promise<PendingRecord[]> {
  const resolved = resolve(directory);
  await mkdir(resolved, { recursive: true, mode: 0o700 });
  await chmod(resolved, 0o700).catch(() => undefined);
  const records: PendingRecord[] = [];
  for (const name of await readdir(resolved)) {
    const match = /^pending-([A-Z0-9]{6,24})\.json$/u.exec(name);
    if (!match) continue;
    try {
      const record = JSON.parse(await readFile(join(resolved, name), "utf8")) as PendingRecord;
      if (!isValidPendingRecord(record)) continue;
      if (Date.parse(record.expiresAt) <= now) {
        await rm(join(resolved, name), { force: true });
        await rm(join(resolved, `decision-${record.publicId}.json`), { force: true });
        continue;
      }
      records.push(record);
    } catch {
      // Invalid or concurrently removed records are not actionable.
    }
  }
  return records.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export async function writeLocalApprovalDecision(
  directory: string,
  publicId: string,
  decision: AgentApprovalDecision,
  now = Date.now(),
): Promise<"written" | "not-found" | "expired" | "already-decided"> {
  const normalizedId = publicId.trim().toUpperCase();
  if (!/^[A-Z0-9]{6,24}$/u.test(normalizedId)) return "not-found";
  const resolved = resolve(directory);
  const pendingPath = join(resolved, `pending-${normalizedId}.json`);
  let record: PendingRecord;
  try {
    record = JSON.parse(await readFile(pendingPath, "utf8")) as PendingRecord;
  } catch {
    return "not-found";
  }
  if (!isValidPendingRecord(record) || record.publicId !== normalizedId) return "not-found";
  if (Date.parse(record.expiresAt) <= now) {
    await rm(pendingPath, { force: true });
    await rm(join(resolved, `decision-${normalizedId}.json`), { force: true });
    return "expired";
  }

  const decisionRecord: DecisionRecord = {
    schemaVersion: 1,
    publicId: record.publicId,
    sessionId: record.sessionId,
    requestFingerprint: record.requestFingerprint,
    decision,
    decidedAt: new Date(now).toISOString(),
  };
  const decisionPath = join(resolved, `decision-${normalizedId}.json`);
  try {
    await writePrivateJsonExclusive(decisionPath, decisionRecord);
  } catch (error) {
    if (isFileExists(error)) return "already-decided";
    throw error;
  }
  return "written";
}

function isValidPendingRecord(record: PendingRecord): boolean {
  return record?.schemaVersion === 1
    && /^[A-Z0-9]{6,24}$/u.test(record.publicId)
    && typeof record.sessionId === "string"
    && typeof record.createdAt === "string"
    && typeof record.expiresAt === "string"
    && typeof record.capability === "string"
    && typeof record.kind === "string"
    && typeof record.source === "string"
    && typeof record.summary === "string"
    && typeof record.conversationHash === "string"
    && typeof record.requestFingerprint === "string";
}

async function writePrivateJsonExclusive(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600).catch(() => undefined);
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
  const temporary = `${path}.tmp-${String(process.pid)}-${Date.now().toString(36)}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await chmod(temporary, 0o600).catch(() => undefined);
    await rename(temporary, path);
    await chmod(path, 0o600).catch(() => undefined);
  } finally {
    await rm(temporary, { force: true });
  }
}

function fingerprintRequest(scope: LocalConfirmationScope, request: AgentApprovalRequest): string {
  return sha256(JSON.stringify({
    userId: scope.userId,
    conversationId: scope.conversationId,
    requestId: request.requestId,
    kind: request.kind,
    capability: request.capability,
    source: request.source,
    mcpServerId: request.mcpServerId ?? null,
    mcpToolName: request.mcpToolName ?? null,
  }));
}

function sanitizeSummary(value: string): string {
  const normalized = value
    .replace(/[\u0000-\u001F\u007F]+/gu, " ")
    .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s]+/giu, "$1=<redacted>")
    .replace(/(--?(?:api[_-]?key|token|secret|password))\s+(?!<redacted>)[^\s]+/giu, "$1 <redacted>")
    .replace(/\bbearer\s+[A-Za-z0-9._~+\/=-]+/giu, "Bearer <redacted>")
    .replace(/\s+/gu, " ")
    .trim();
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 237)}...`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isFileExists(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "EEXIST";
}

function isFileMissing(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}
