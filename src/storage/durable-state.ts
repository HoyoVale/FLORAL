import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "./sqlite.js";

export type DurableTransactionKind =
  | "agent-run"
  | "delivery"
  | "maintenance"
  | "extension"
  | "context"
  | "attachment";

export type DurableTransactionStatus =
  | "created"
  | "accepted"
  | "executing"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

export interface DurableTransaction {
  id: string;
  kind: DurableTransactionKind;
  status: DurableTransactionStatus;
  idempotencyKey?: string | undefined;
  correlationId?: string | undefined;
  conversationId?: string | undefined;
  projectId?: string | undefined;
  attempt: number;
  maxAttempts: number;
  nextRetryAt?: number | undefined;
  leaseOwner?: string | undefined;
  leaseExpiresAt?: number | undefined;
  payload: Record<string, unknown>;
  result?: Record<string, unknown> | undefined;
  errorCode?: string | undefined;
  createdAt: number;
  updatedAt: number;
}

export interface DurableTransactionEvent {
  id: string;
  transactionId: string;
  sequence: number;
  eventType: string;
  fromStatus?: DurableTransactionStatus | undefined;
  toStatus?: DurableTransactionStatus | undefined;
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface CreateDurableTransactionInput {
  kind: DurableTransactionKind;
  idempotencyKey?: string | undefined;
  correlationId?: string | undefined;
  conversationId?: string | undefined;
  projectId?: string | undefined;
  maxAttempts?: number | undefined;
  payload?: Record<string, unknown> | undefined;
}

export interface TransitionDurableTransactionInput {
  status: DurableTransactionStatus;
  eventType: string;
  payload?: Record<string, unknown> | undefined;
  result?: Record<string, unknown> | undefined;
  errorCode?: string | undefined;
  nextRetryAt?: number | undefined;
}

const TRANSITIONS: Readonly<Record<DurableTransactionStatus, ReadonlySet<DurableTransactionStatus>>> = {
  created: new Set(["accepted", "failed", "cancelled"]),
  accepted: new Set(["executing", "waiting", "failed", "cancelled"]),
  executing: new Set(["waiting", "completed", "failed", "cancelled"]),
  waiting: new Set(["accepted", "executing", "completed", "failed", "cancelled"]),
  completed: new Set(),
  failed: new Set(["accepted", "cancelled"]),
  cancelled: new Set(),
};

export class DurableStateStore {
  constructor(private readonly db: SqliteDatabase) {
    migrateDurableStateSchema(db);
  }

  createTransaction(input: CreateDurableTransactionInput): DurableTransaction {
    assertKind(input.kind);
    const now = Date.now();
    const id = randomUUID();
    const idempotencyKey = normalizeOptionalToken(input.idempotencyKey, 240, "idempotency key");
    const maxAttempts = input.maxAttempts ?? 5;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
      throw new Error("Durable transaction maxAttempts must be between 1 and 100");
    }
    const payloadJson = encodeJson(input.payload ?? {}, 64 * 1_024, "transaction payload");

    return this.db.transaction(() => {
      if (idempotencyKey) {
        const existing = this.#findByIdempotency(input.kind, idempotencyKey);
        if (existing) return existing;
      }
      this.db.prepare(`
        INSERT INTO durable_transactions (
          id, kind, status, idempotency_key, correlation_id,
          conversation_id, project_id, attempt, max_attempts,
          payload_json, created_at, updated_at
        ) VALUES (?, ?, 'created', ?, ?, ?, ?, 0, ?, ?, ?, ?)
      `).run(
        id,
        input.kind,
        idempotencyKey ?? null,
        normalizeOptionalToken(input.correlationId, 240, "correlation id") ?? null,
        normalizeOptionalToken(input.conversationId, 240, "conversation id") ?? null,
        normalizeOptionalToken(input.projectId, 240, "project id") ?? null,
        maxAttempts,
        payloadJson,
        now,
        now,
      );
      this.#appendEvent({
        transactionId: id,
        eventType: "transaction.created",
        toStatus: "created",
        payload: input.payload ?? {},
        createdAt: now,
      });
      return this.requireTransaction(id);
    })();
  }

  getTransaction(id: string): DurableTransaction | undefined {
    assertToken(id, 240, "transaction id");
    return parseTransaction(this.db.prepare(`
      SELECT * FROM durable_transactions WHERE id = ? LIMIT 1
    `).get(id));
  }

  requireTransaction(id: string): DurableTransaction {
    const transaction = this.getTransaction(id);
    if (!transaction) throw new Error(`Durable transaction not found: ${id}`);
    return transaction;
  }

  findByIdempotency(
    kind: DurableTransactionKind,
    idempotencyKey: string,
  ): DurableTransaction | undefined {
    assertKind(kind);
    assertToken(idempotencyKey, 240, "idempotency key");
    return this.#findByIdempotency(kind, idempotencyKey);
  }

  transition(
    id: string,
    input: TransitionDurableTransactionInput,
  ): DurableTransaction {
    assertEventType(input.eventType);
    assertStatus(input.status);
    return this.db.transaction(() => {
      const current = this.requireTransaction(id);
      if (current.status === input.status) return current;
      if (!TRANSITIONS[current.status].has(input.status)) {
        throw new Error(
          `Invalid durable transaction transition: ${current.status} -> ${input.status}`,
        );
      }
      if (input.status === "accepted" && current.status === "failed") {
        if (current.attempt >= current.maxAttempts) {
          throw new Error("Durable transaction retry limit reached");
        }
      }
      const now = Date.now();
      const resultJson = input.result
        ? encodeJson(input.result, 64 * 1_024, "transaction result")
        : null;
      this.db.prepare(`
        UPDATE durable_transactions
        SET status = ?, result_json = COALESCE(?, result_json),
            error_code = ?, next_retry_at = ?,
            lease_owner = CASE WHEN ? IN ('completed', 'failed', 'cancelled') THEN NULL ELSE lease_owner END,
            lease_expires_at = CASE WHEN ? IN ('completed', 'failed', 'cancelled') THEN NULL ELSE lease_expires_at END,
            updated_at = ?
        WHERE id = ?
      `).run(
        input.status,
        resultJson,
        normalizeOptionalToken(input.errorCode, 160, "error code") ?? null,
        readOptionalTimestamp(input.nextRetryAt, "nextRetryAt") ?? null,
        input.status,
        input.status,
        now,
        id,
      );
      this.#appendEvent({
        transactionId: id,
        eventType: input.eventType,
        fromStatus: current.status,
        toStatus: input.status,
        payload: input.payload ?? {},
        createdAt: now,
      });
      return this.requireTransaction(id);
    })();
  }

  acquireLease(
    id: string,
    owner: string,
    ttlMs: number,
    now = Date.now(),
  ): DurableTransaction | undefined {
    assertToken(owner, 160, "lease owner");
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 24 * 60 * 60 * 1_000) {
      throw new Error("Lease ttlMs must be between 1000 and 86400000");
    }
    return this.db.transaction(() => {
      const current = this.requireTransaction(id);
      if (current.status !== "accepted" && current.status !== "waiting") return undefined;
      if (current.attempt >= current.maxAttempts) return undefined;
      if (current.leaseExpiresAt && current.leaseExpiresAt > now && current.leaseOwner !== owner) {
        return undefined;
      }
      const expiresAt = now + ttlMs;
      const update = this.db.prepare(`
        UPDATE durable_transactions
        SET status = 'executing', attempt = attempt + 1,
            lease_owner = ?, lease_expires_at = ?, updated_at = ?
        WHERE id = ?
          AND status IN ('accepted', 'waiting')
          AND attempt < max_attempts
          AND (lease_expires_at IS NULL OR lease_expires_at <= ? OR lease_owner = ?)
      `).run(owner, expiresAt, now, id, now, owner);
      if (update.changes !== 1) return undefined;
      this.#appendEvent({
        transactionId: id,
        eventType: "transaction.lease-acquired",
        fromStatus: current.status,
        toStatus: "executing",
        payload: { owner, expiresAt },
        createdAt: now,
      });
      return this.requireTransaction(id);
    })();
  }

  renewLease(id: string, owner: string, ttlMs: number, now = Date.now()): boolean {
    assertToken(owner, 160, "lease owner");
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 24 * 60 * 60 * 1_000) {
      throw new Error("Lease ttlMs must be between 1000 and 86400000");
    }
    const result = this.db.prepare(`
      UPDATE durable_transactions
      SET lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND status = 'executing' AND lease_owner = ? AND lease_expires_at > ?
    `).run(now + ttlMs, now, id, owner, now);
    return result.changes === 1;
  }

  recoverExpiredLeases(now = Date.now()): DurableTransaction[] {
    return this.db.transaction(() => {
      const rows = this.db.prepare(`
        SELECT * FROM durable_transactions
        WHERE status = 'executing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
        ORDER BY created_at, id
      `).all(now).map(parseTransaction).filter(isPresent);
      for (const transaction of rows) {
        const exhausted = transaction.attempt >= transaction.maxAttempts;
        const status: DurableTransactionStatus = exhausted ? "failed" : "waiting";
        this.db.prepare(`
          UPDATE durable_transactions
          SET status = ?, lease_owner = NULL, lease_expires_at = NULL,
              error_code = ?, next_retry_at = ?, updated_at = ?
          WHERE id = ? AND status = 'executing'
        `).run(
          status,
          exhausted ? "lease-expired-retry-limit" : "lease-expired",
          exhausted ? null : now,
          now,
          transaction.id,
        );
        this.#appendEvent({
          transactionId: transaction.id,
          eventType: exhausted
            ? "transaction.lease-expired-terminal"
            : "transaction.lease-expired-recovered",
          fromStatus: "executing",
          toStatus: status,
          payload: { previousOwner: transaction.leaseOwner ?? "unknown" },
          createdAt: now,
        });
      }
      return rows.map((entry) => this.requireTransaction(entry.id));
    })();
  }

  listRecoverable(limit = 100, now = Date.now()): DurableTransaction[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("Recoverable transaction limit must be between 1 and 1000");
    }
    return this.db.prepare(`
      SELECT * FROM durable_transactions
      WHERE status IN ('accepted', 'waiting')
        AND attempt < max_attempts
        AND (next_retry_at IS NULL OR next_retry_at <= ?)
        AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
      ORDER BY created_at, id
      LIMIT ?
    `).all(now, now, limit).map(parseTransaction).filter(isPresent);
  }

  listEvents(transactionId: string, limit = 200): DurableTransactionEvent[] {
    assertToken(transactionId, 240, "transaction id");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("Transaction event limit must be between 1 and 1000");
    }
    return this.db.prepare(`
      SELECT * FROM durable_transaction_events
      WHERE transaction_id = ?
      ORDER BY sequence
      LIMIT ?
    `).all(transactionId, limit).map(parseEvent).filter(isPresent);
  }

  diagnostics(): {
    transactions: number;
    events: number;
    recoverable: number;
    executing: number;
    terminalFailed: number;
  } {
    return {
      transactions: count(this.db, "durable_transactions"),
      events: count(this.db, "durable_transaction_events"),
      recoverable: readCount(this.db.prepare(`
        SELECT COUNT(*) AS count FROM durable_transactions
        WHERE status IN ('accepted', 'waiting') AND attempt < max_attempts
      `).get()),
      executing: readCount(this.db.prepare(`
        SELECT COUNT(*) AS count FROM durable_transactions WHERE status = 'executing'
      `).get()),
      terminalFailed: readCount(this.db.prepare(`
        SELECT COUNT(*) AS count FROM durable_transactions WHERE status = 'failed'
      `).get()),
    };
  }

  #findByIdempotency(
    kind: DurableTransactionKind,
    idempotencyKey: string,
  ): DurableTransaction | undefined {
    return parseTransaction(this.db.prepare(`
      SELECT * FROM durable_transactions
      WHERE kind = ? AND idempotency_key = ?
      LIMIT 1
    `).get(kind, idempotencyKey));
  }

  #appendEvent(input: {
    transactionId: string;
    eventType: string;
    fromStatus?: DurableTransactionStatus | undefined;
    toStatus?: DurableTransactionStatus | undefined;
    payload: Record<string, unknown>;
    createdAt: number;
  }): void {
    assertEventType(input.eventType);
    const sequence = readCount(this.db.prepare(`
      SELECT COALESCE(MAX(sequence), 0) + 1 AS count
      FROM durable_transaction_events WHERE transaction_id = ?
    `).get(input.transactionId));
    this.db.prepare(`
      INSERT INTO durable_transaction_events (
        id, transaction_id, sequence, event_type,
        from_status, to_status, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      input.transactionId,
      sequence,
      input.eventType,
      input.fromStatus ?? null,
      input.toStatus ?? null,
      encodeJson(input.payload, 32 * 1_024, "transaction event payload"),
      input.createdAt,
    );
  }
}

export function migrateDurableStateSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS durable_transactions (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN (
        'created', 'accepted', 'executing', 'waiting',
        'completed', 'failed', 'cancelled'
      )),
      idempotency_key TEXT,
      correlation_id TEXT,
      conversation_id TEXT,
      project_id TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      next_retry_at INTEGER,
      lease_owner TEXT,
      lease_expires_at INTEGER,
      payload_json TEXT NOT NULL,
      result_json TEXT,
      error_code TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(kind, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS durable_transaction_events (
      id TEXT PRIMARY KEY,
      transaction_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(transaction_id, sequence),
      FOREIGN KEY(transaction_id) REFERENCES durable_transactions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS durable_transactions_recovery_idx
      ON durable_transactions(status, next_retry_at, lease_expires_at, created_at);
    CREATE INDEX IF NOT EXISTS durable_transactions_correlation_idx
      ON durable_transactions(correlation_id, created_at);
    CREATE INDEX IF NOT EXISTS durable_transaction_events_transaction_idx
      ON durable_transaction_events(transaction_id, sequence);
  `);
}

function parseTransaction(value: unknown): DurableTransaction | undefined {
  const row = asRecord(value);
  if (!row) return undefined;
  const kind = row.kind;
  const status = row.status;
  assertKind(kind);
  assertStatus(status);
  return {
    id: requireString(row.id, "transaction id"),
    kind,
    status,
    ...(optionalString(row.idempotency_key) ? { idempotencyKey: optionalString(row.idempotency_key) } : {}),
    ...(optionalString(row.correlation_id) ? { correlationId: optionalString(row.correlation_id) } : {}),
    ...(optionalString(row.conversation_id) ? { conversationId: optionalString(row.conversation_id) } : {}),
    ...(optionalString(row.project_id) ? { projectId: optionalString(row.project_id) } : {}),
    attempt: requireInteger(row.attempt, "transaction attempt"),
    maxAttempts: requireInteger(row.max_attempts, "transaction max attempts"),
    ...(optionalInteger(row.next_retry_at) !== undefined ? { nextRetryAt: optionalInteger(row.next_retry_at) } : {}),
    ...(optionalString(row.lease_owner) ? { leaseOwner: optionalString(row.lease_owner) } : {}),
    ...(optionalInteger(row.lease_expires_at) !== undefined ? { leaseExpiresAt: optionalInteger(row.lease_expires_at) } : {}),
    payload: decodeJsonObject(row.payload_json, "transaction payload"),
    ...(row.result_json !== null && row.result_json !== undefined
      ? { result: decodeJsonObject(row.result_json, "transaction result") }
      : {}),
    ...(optionalString(row.error_code) ? { errorCode: optionalString(row.error_code) } : {}),
    createdAt: requireInteger(row.created_at, "transaction createdAt"),
    updatedAt: requireInteger(row.updated_at, "transaction updatedAt"),
  };
}

function parseEvent(value: unknown): DurableTransactionEvent | undefined {
  const row = asRecord(value);
  if (!row) return undefined;
  const fromStatus = row.from_status;
  const toStatus = row.to_status;
  if (fromStatus !== null && fromStatus !== undefined) assertStatus(fromStatus);
  if (toStatus !== null && toStatus !== undefined) assertStatus(toStatus);
  return {
    id: requireString(row.id, "event id"),
    transactionId: requireString(row.transaction_id, "event transaction id"),
    sequence: requireInteger(row.sequence, "event sequence"),
    eventType: requireString(row.event_type, "event type"),
    ...(fromStatus ? { fromStatus } : {}),
    ...(toStatus ? { toStatus } : {}),
    payload: decodeJsonObject(row.payload_json, "event payload"),
    createdAt: requireInteger(row.created_at, "event createdAt"),
  };
}

function assertKind(value: unknown): asserts value is DurableTransactionKind {
  if (
    value !== "agent-run"
    && value !== "delivery"
    && value !== "maintenance"
    && value !== "extension"
    && value !== "context"
    && value !== "attachment"
  ) throw new Error("Durable transaction kind is invalid");
}

function assertStatus(value: unknown): asserts value is DurableTransactionStatus {
  if (
    value !== "created" && value !== "accepted" && value !== "executing"
    && value !== "waiting" && value !== "completed" && value !== "failed"
    && value !== "cancelled"
  ) throw new Error("Durable transaction status is invalid");
}

function assertEventType(value: string): void {
  if (!/^[a-z0-9_.-]{1,120}$/iu.test(value)) {
    throw new Error("Durable transaction event type is invalid");
  }
}

function assertToken(value: string, maxLength: number, label: string): void {
  if (!value.trim() || value.length > maxLength || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`Durable ${label} is invalid`);
  }
}

function normalizeOptionalToken(
  value: string | undefined,
  maxLength: number,
  label: string,
): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  assertToken(normalized, maxLength, label);
  return normalized;
}

function readOptionalTimestamp(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Durable ${label} is invalid`);
  }
  return value;
}

function encodeJson(value: Record<string, unknown>, maxBytes: number, label: string): string {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, "utf8") > maxBytes) {
    throw new Error(`Durable ${label} exceeds ${String(maxBytes)} bytes`);
  }
  return json;
}

function decodeJsonObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "string") throw new Error(`Stored durable ${label} is invalid`);
  const parsed: unknown = JSON.parse(value);
  const record = asRecord(parsed);
  if (!record) throw new Error(`Stored durable ${label} is not an object`);
  return record;
}

function count(db: SqliteDatabase, table: string): number {
  return readCount(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get());
}

function readCount(value: unknown): number {
  const countValue = asRecord(value)?.count;
  if (typeof countValue !== "number" || !Number.isSafeInteger(countValue) || countValue < 0) {
    throw new Error("Stored durable count is invalid");
  }
  return countValue;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Stored ${label} is invalid`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requireInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Stored ${label} is invalid`);
  }
  return value;
}

function optionalInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined;
}
