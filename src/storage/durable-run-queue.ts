import type { IncomingMessage, ResolvedGatewayIdentity } from "../core/types.js";
import type { SqliteDatabase } from "./sqlite.js";
import { DurableStateStore, type DurableTransaction } from "./durable-state.js";

export interface DurableAgentRunRecord {
  id: string;
  idempotencyKey: string;
  conversationId: string;
  message: IncomingMessage;
  resolved: ResolvedGatewayIdentity;
  createdAt: number;
  updatedAt: number;
  transaction: DurableTransaction;
}

export class DurableRunQueueStore {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly durability: DurableStateStore,
  ) {
    migrateDurableRunQueueSchema(db);
  }

  enqueue(input: {
    message: IncomingMessage;
    resolved: ResolvedGatewayIdentity;
    projectId?: string | undefined;
    maxAttempts?: number | undefined;
  }): DurableAgentRunRecord {
    validateMessage(input.message);
    validateResolved(input.resolved);
    const idempotencyKey = inboundIdempotencyKey(input.message);
    const transaction = this.durability.createTransaction({
      kind: "agent-run",
      idempotencyKey,
      correlationId: input.message.id,
      conversationId: input.resolved.conversationId,
      projectId: input.projectId,
      maxAttempts: input.maxAttempts ?? 3,
      payload: {
        transport: input.message.identity.transport,
        attachmentCount: input.message.attachments?.length ?? 0,
      },
    });
    const now = Date.now();
    this.db.prepare(`
      INSERT OR IGNORE INTO durable_run_queue (
        id, transaction_id, idempotency_key, conversation_id,
        message_json, resolved_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      transaction.id,
      transaction.id,
      idempotencyKey,
      input.resolved.conversationId,
      encodeMessage(input.message),
      JSON.stringify(input.resolved),
      now,
      now,
    );
    if (transaction.status === "created") {
      this.durability.transition(transaction.id, {
        status: "accepted",
        eventType: "agent-run.queued",
      });
    }
    return this.require(transaction.id);
  }

  get(id: string): DurableAgentRunRecord | undefined {
    return this.#parse(this.db.prepare(`
      SELECT * FROM durable_run_queue WHERE id = ? LIMIT 1
    `).get(id));
  }

  require(id: string): DurableAgentRunRecord {
    const record = this.get(id);
    if (!record) throw new Error(`Durable agent run not found: ${id}`);
    return record;
  }

  claimById(
    id: string,
    owner: string,
    leaseTtlMs: number,
    now = Date.now(),
  ): DurableAgentRunRecord | undefined {
    const current = this.get(id);
    if (!current || current.transaction.kind !== "agent-run") return undefined;
    const leased = this.durability.acquireLease(id, owner, leaseTtlMs, now);
    return leased ? this.require(id) : undefined;
  }

  claimNext(
    owner: string,
    leaseTtlMs: number,
    conversationId?: string,
    now = Date.now(),
  ): DurableAgentRunRecord | undefined {
    const candidates = this.durability.listRecoverable(1_000, now)
      .filter((transaction) => transaction.kind === "agent-run")
      .filter((transaction) => !conversationId || transaction.conversationId === conversationId);
    for (const transaction of candidates) {
      const record = this.claimById(transaction.id, owner, leaseTtlMs, now);
      if (record) return record;
    }
    return undefined;
  }

  renewLease(id: string, owner: string, leaseTtlMs: number): boolean {
    return this.durability.renewLease(id, owner, leaseTtlMs);
  }

  markCompleted(id: string, result: Record<string, unknown> = {}): DurableAgentRunRecord {
    const current = this.require(id);
    if (current.transaction.status === "completed") return current;
    if (current.transaction.status !== "executing") {
      throw new Error("Durable agent run must be leased before completion");
    }
    this.durability.transition(id, {
      status: "completed",
      eventType: "agent-run.completed",
      result,
    });
    this.#touch(id);
    return this.require(id);
  }

  markFailed(id: string, errorCode: string): DurableAgentRunRecord {
    const current = this.require(id);
    if (current.transaction.status === "failed") return current;
    if (current.transaction.status !== "executing") {
      throw new Error("Durable agent run must be leased before failure");
    }
    this.durability.transition(id, {
      status: "failed",
      eventType: "agent-run.failed-terminal",
      errorCode: normalizeErrorCode(errorCode),
    });
    this.#touch(id);
    return this.require(id);
  }

  markRecoveryUnsafe(id: string): DurableAgentRunRecord {
    const current = this.require(id);
    if (current.transaction.status === "failed") return current;
    if (current.transaction.status !== "accepted" && current.transaction.status !== "waiting") {
      throw new Error("Durable agent run must be pending before recovery quarantine");
    }
    this.durability.transition(id, {
      status: "failed",
      eventType: "agent-run.recovery-ambiguous-terminal",
      errorCode: "ambiguous-interrupted-run",
    });
    this.#touch(id);
    return this.require(id);
  }

  cancelPending(conversationId: string): number {
    const records = this.listPending(conversationId, 1_000)
      .filter((record) => record.transaction.status === "accepted" || record.transaction.status === "waiting");
    for (const record of records) {
      this.durability.transition(record.id, {
        status: "cancelled",
        eventType: "agent-run.cancelled",
      });
      this.#touch(record.id);
    }
    return records.length;
  }

  recoverExpiredLeases(now = Date.now()): DurableAgentRunRecord[] {
    return this.durability.recoverExpiredLeases(now)
      .filter((transaction) => transaction.kind === "agent-run")
      .flatMap((transaction) => {
        const record = this.get(transaction.id);
        return record ? [record] : [];
      });
  }

  listPending(conversationId?: string, limit = 100): DurableAgentRunRecord[] {
    const rows = conversationId
      ? this.db.prepare(`
          SELECT q.* FROM durable_run_queue AS q
          JOIN durable_transactions AS t ON t.id = q.transaction_id
          WHERE q.conversation_id = ? AND t.status IN ('accepted', 'waiting', 'executing')
          ORDER BY q.created_at, q.id LIMIT ?
        `).all(conversationId, limit)
      : this.db.prepare(`
          SELECT q.* FROM durable_run_queue AS q
          JOIN durable_transactions AS t ON t.id = q.transaction_id
          WHERE t.status IN ('accepted', 'waiting', 'executing')
          ORDER BY q.created_at, q.id LIMIT ?
        `).all(limit);
    return rows.map((row) => this.#parse(row)).filter(isPresent);
  }

  pendingCount(conversationId?: string): number {
    return this.listPending(conversationId, 1_000)
      .filter((record) => record.transaction.status !== "executing")
      .length;
  }

  pendingConversations(): string[] {
    return [...new Set(this.listPending(undefined, 1_000)
      .filter((record) => record.transaction.status !== "executing")
      .map((record) => record.conversationId))];
  }

  diagnostics(): { pending: number; executing: number; failed: number; completed: number } {
    const row = asRecord(this.db.prepare(`
      SELECT
        SUM(CASE WHEN t.status IN ('accepted', 'waiting') THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN t.status = 'executing' THEN 1 ELSE 0 END) AS executing,
        SUM(CASE WHEN t.status = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN t.status = 'completed' THEN 1 ELSE 0 END) AS completed
      FROM durable_run_queue AS q
      JOIN durable_transactions AS t ON t.id = q.transaction_id
    `).get());
    return {
      pending: aggregate(row?.pending),
      executing: aggregate(row?.executing),
      failed: aggregate(row?.failed),
      completed: aggregate(row?.completed),
    };
  }

  #touch(id: string): void {
    this.db.prepare("UPDATE durable_run_queue SET updated_at = ? WHERE id = ?")
      .run(Date.now(), id);
  }

  #parse(value: unknown): DurableAgentRunRecord | undefined {
    const row = asRecord(value);
    if (!row) return undefined;
    const id = requireString(row.id, "run id");
    return {
      id,
      idempotencyKey: requireString(row.idempotency_key, "idempotency key"),
      conversationId: requireString(row.conversation_id, "conversation id"),
      message: decodeMessage(row.message_json),
      resolved: decodeResolved(row.resolved_json),
      createdAt: requireInteger(row.created_at, "createdAt"),
      updatedAt: requireInteger(row.updated_at, "updatedAt"),
      transaction: this.durability.requireTransaction(id),
    };
  }
}

export function migrateDurableRunQueueSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS durable_run_queue (
      id TEXT PRIMARY KEY,
      transaction_id TEXT NOT NULL UNIQUE,
      idempotency_key TEXT NOT NULL UNIQUE,
      conversation_id TEXT NOT NULL,
      message_json TEXT NOT NULL,
      resolved_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(transaction_id) REFERENCES durable_transactions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS durable_run_queue_pending_idx
      ON durable_run_queue(conversation_id, created_at);
  `);
}

function inboundIdempotencyKey(message: IncomingMessage): string {
  return `inbound:${message.identity.transport}:${message.identity.botId}:${message.id}`;
}

function encodeMessage(message: IncomingMessage): string {
  return JSON.stringify({ ...message, receivedAt: message.receivedAt.toISOString() });
}

function decodeMessage(value: unknown): IncomingMessage {
  if (typeof value !== "string") throw new Error("Stored run message is invalid");
  const record = asRecord(JSON.parse(value) as unknown);
  if (!record || typeof record.receivedAt !== "string") {
    throw new Error("Stored run message timestamp is invalid");
  }
  const message = { ...record, receivedAt: new Date(record.receivedAt) } as unknown as IncomingMessage;
  validateMessage(message);
  return message;
}

function decodeResolved(value: unknown): ResolvedGatewayIdentity {
  if (typeof value !== "string") throw new Error("Stored resolved identity is invalid");
  const resolved = JSON.parse(value) as ResolvedGatewayIdentity;
  validateResolved(resolved);
  return resolved;
}

function validateMessage(message: IncomingMessage): void {
  if (!message.id?.trim() || !message.identity?.conversationId?.trim() || typeof message.text !== "string") {
    throw new Error("Durable run message is invalid");
  }
  if (!(message.receivedAt instanceof Date) || !Number.isFinite(message.receivedAt.getTime())) {
    throw new Error("Durable run message timestamp is invalid");
  }
  if (message.attachments?.some((attachment) => !attachment.localPath?.trim())) {
    throw new Error("Durable queued attachments must be materialized before enqueue");
  }
  if (Buffer.byteLength(encodeMessage(message), "utf8") > 256 * 1_024) {
    throw new Error("Durable run message is too large");
  }
}

function validateResolved(value: ResolvedGatewayIdentity): void {
  if (!value.userId?.trim() || !value.conversationId?.trim()
    || !["owner", "operator", "viewer"].includes(value.role)) {
    throw new Error("Durable resolved identity is invalid");
  }
}

function normalizeErrorCode(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9-]/gu, "-").slice(0, 120);
  return normalized || "error";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Stored ${label} is invalid`);
  return value;
}

function requireInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Stored ${label} is invalid`);
  }
  return value;
}

function aggregate(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined;
}
