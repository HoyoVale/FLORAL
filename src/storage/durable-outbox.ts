import type { OutgoingMediaMessage } from "../core/types.js";
import type { SqliteDatabase } from "./sqlite.js";
import {
  DurableStateStore,
  type DurableTransaction,
} from "./durable-state.js";

export type DurableDeliveryPayload =
  | { kind: "text"; text: string }
  | { kind: "media"; media: Omit<OutgoingMediaMessage, "conversationId"> };

export interface DurableOutboxRecord {
  id: string;
  transactionId: string;
  idempotencyKey: string;
  conversationId: string;
  payload: DurableDeliveryPayload;
  deliveredAt?: number | undefined;
  acknowledgement?: Record<string, unknown> | undefined;
  lastErrorCode?: string | undefined;
  createdAt: number;
  updatedAt: number;
  transaction: DurableTransaction;
}

export class DurableOutboxStore {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly durability: DurableStateStore,
  ) {
    migrateDurableOutboxSchema(db);
  }

  enqueue(input: {
    idempotencyKey: string;
    conversationId: string;
    correlationId?: string | undefined;
    projectId?: string | undefined;
    payload: DurableDeliveryPayload;
    maxAttempts?: number | undefined;
  }): DurableOutboxRecord {
    assertToken(input.idempotencyKey, 240, "delivery idempotency key");
    assertToken(input.conversationId, 240, "delivery conversation id");
    validatePayload(input.payload);
    const transaction = this.durability.createTransaction({
      kind: "delivery",
      idempotencyKey: input.idempotencyKey,
      correlationId: input.correlationId,
      conversationId: input.conversationId,
      projectId: input.projectId,
      maxAttempts: input.maxAttempts ?? 8,
      payload: { deliveryKind: input.payload.kind },
    });
    const now = Date.now();
    this.db.prepare(`
      INSERT OR IGNORE INTO durable_outbox (
        id, transaction_id, idempotency_key, conversation_id,
        payload_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      transaction.id,
      transaction.id,
      input.idempotencyKey,
      input.conversationId,
      JSON.stringify(input.payload),
      now,
      now,
    );
    if (transaction.status === "created") {
      this.durability.transition(transaction.id, {
        status: "accepted",
        eventType: "delivery.queued",
      });
    }
    return this.require(transaction.id);
  }

  get(id: string): DurableOutboxRecord | undefined {
    assertToken(id, 240, "outbox id");
    return this.#parse(this.db.prepare(`
      SELECT * FROM durable_outbox WHERE id = ? LIMIT 1
    `).get(id));
  }

  require(id: string): DurableOutboxRecord {
    const record = this.get(id);
    if (!record) throw new Error(`Durable outbox record not found: ${id}`);
    return record;
  }

  claimNext(
    owner: string,
    leaseTtlMs: number,
    now = Date.now(),
  ): DurableOutboxRecord | undefined {
    const candidates = this.durability.listRecoverable(200, now)
      .filter((transaction) => transaction.kind === "delivery");
    for (const transaction of candidates) {
      const record = this.get(transaction.id);
      if (!record || record.deliveredAt !== undefined) continue;
      const leased = this.durability.acquireLease(
        transaction.id,
        owner,
        leaseTtlMs,
        now,
      );
      if (leased) return this.require(transaction.id);
    }
    return undefined;
  }

  markDelivered(
    id: string,
    acknowledgement: Record<string, unknown> = {},
    now = Date.now(),
  ): DurableOutboxRecord {
    const current = this.require(id);
    if (current.deliveredAt !== undefined || current.transaction.status === "completed") {
      return current;
    }
    if (current.transaction.status !== "executing") {
      throw new Error("Durable delivery must be leased before acknowledgement");
    }
    const acknowledgementJson = JSON.stringify(acknowledgement);
    if (Buffer.byteLength(acknowledgementJson, "utf8") > 16 * 1_024) {
      throw new Error("Durable delivery acknowledgement is too large");
    }
    this.db.prepare(`
      UPDATE durable_outbox
      SET delivered_at = ?, acknowledgement_json = ?,
          last_error_code = NULL, updated_at = ?
      WHERE id = ?
    `).run(now, acknowledgementJson, now, id);
    this.durability.transition(id, {
      status: "completed",
      eventType: "delivery.acknowledged",
      result: acknowledgement,
    });
    return this.require(id);
  }

  markAttemptFailed(
    id: string,
    errorCode: string,
    options: { retryAt?: number | undefined; terminal?: boolean | undefined } = {},
  ): DurableOutboxRecord {
    assertToken(errorCode, 160, "delivery error code");
    const current = this.require(id);
    if (current.transaction.status !== "executing") {
      throw new Error("Durable delivery must be leased before failure recording");
    }
    const terminal = options.terminal === true
      || current.transaction.attempt >= current.transaction.maxAttempts;
    const retryAt = terminal ? undefined : options.retryAt ?? Date.now();
    this.db.prepare(`
      UPDATE durable_outbox
      SET last_error_code = ?, updated_at = ?
      WHERE id = ?
    `).run(errorCode, Date.now(), id);
    this.durability.transition(id, {
      status: terminal ? "failed" : "waiting",
      eventType: terminal ? "delivery.failed-terminal" : "delivery.retry-scheduled",
      errorCode,
      ...(retryAt !== undefined ? { nextRetryAt: retryAt } : {}),
    });
    return this.require(id);
  }

  markRecoveryUnsafe(id: string, errorCode: string): DurableOutboxRecord {
    const current = this.require(id);
    if (current.transaction.status === "failed") return current;
    if (current.transaction.status !== "waiting" && current.transaction.status !== "accepted") {
      throw new Error("Durable delivery must be pending before recovery quarantine");
    }
    assertToken(errorCode, 160, "delivery error code");
    this.db.prepare(`
      UPDATE durable_outbox SET last_error_code = ?, updated_at = ? WHERE id = ?
    `).run(errorCode, Date.now(), id);
    this.durability.transition(id, {
      status: "failed",
      eventType: "delivery.recovery-ambiguous-terminal",
      errorCode,
    });
    return this.require(id);
  }

  recoverExpiredLeases(now = Date.now()): DurableOutboxRecord[] {
    return this.durability.recoverExpiredLeases(now)
      .filter((transaction) => transaction.kind === "delivery")
      .flatMap((transaction) => {
        const record = this.get(transaction.id);
        return record ? [record] : [];
      });
  }

  listPending(limit = 100): DurableOutboxRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("Durable outbox limit must be between 1 and 1000");
    }
    return this.db.prepare(`
      SELECT o.* FROM durable_outbox AS o
      JOIN durable_transactions AS t ON t.id = o.transaction_id
      WHERE o.delivered_at IS NULL
        AND t.status NOT IN ('completed', 'failed', 'cancelled')
      ORDER BY o.created_at, o.id
      LIMIT ?
    `).all(limit).map((value) => this.#parse(value)).filter(isPresent);
  }

  diagnostics(): {
    pending: number;
    delivered: number;
    failed: number;
    oldestPendingAt?: number | undefined;
  } {
    const row = asRecord(this.db.prepare(`
      SELECT
        SUM(CASE WHEN o.delivered_at IS NULL AND t.status != 'failed' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN o.delivered_at IS NOT NULL THEN 1 ELSE 0 END) AS delivered,
        SUM(CASE WHEN t.status = 'failed' THEN 1 ELSE 0 END) AS failed,
        MIN(CASE WHEN o.delivered_at IS NULL AND t.status != 'failed' THEN o.created_at ELSE NULL END) AS oldest_pending_at
      FROM durable_outbox AS o
      JOIN durable_transactions AS t ON t.id = o.transaction_id
    `).get());
    return {
      pending: readAggregate(row?.pending),
      delivered: readAggregate(row?.delivered),
      failed: readAggregate(row?.failed),
      ...(readOptionalInteger(row?.oldest_pending_at) !== undefined
        ? { oldestPendingAt: readOptionalInteger(row?.oldest_pending_at) }
        : {}),
    };
  }

  #parse(value: unknown): DurableOutboxRecord | undefined {
    const row = asRecord(value);
    if (!row) return undefined;
    const id = requireString(row.id, "outbox id");
    const payload = parsePayload(row.payload_json);
    return {
      id,
      transactionId: requireString(row.transaction_id, "outbox transaction id"),
      idempotencyKey: requireString(row.idempotency_key, "outbox idempotency key"),
      conversationId: requireString(row.conversation_id, "outbox conversation id"),
      payload,
      ...(readOptionalInteger(row.delivered_at) !== undefined
        ? { deliveredAt: readOptionalInteger(row.delivered_at) }
        : {}),
      ...(row.acknowledgement_json !== null && row.acknowledgement_json !== undefined
        ? { acknowledgement: parseJsonObject(row.acknowledgement_json, "outbox acknowledgement") }
        : {}),
      ...(optionalString(row.last_error_code)
        ? { lastErrorCode: optionalString(row.last_error_code) }
        : {}),
      createdAt: requireInteger(row.created_at, "outbox createdAt"),
      updatedAt: requireInteger(row.updated_at, "outbox updatedAt"),
      transaction: this.durability.requireTransaction(id),
    };
  }
}

export function migrateDurableOutboxSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS durable_outbox (
      id TEXT PRIMARY KEY,
      transaction_id TEXT NOT NULL UNIQUE,
      idempotency_key TEXT NOT NULL UNIQUE,
      conversation_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      delivered_at INTEGER,
      acknowledgement_json TEXT,
      last_error_code TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(transaction_id) REFERENCES durable_transactions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS durable_outbox_pending_idx
      ON durable_outbox(delivered_at, created_at);
    CREATE INDEX IF NOT EXISTS durable_outbox_conversation_idx
      ON durable_outbox(conversation_id, created_at);
  `);
}

function validatePayload(payload: DurableDeliveryPayload): void {
  if (payload.kind === "text") {
    if (!payload.text.trim() || payload.text.length > 64_000) {
      throw new Error("Durable text delivery payload is invalid");
    }
  } else {
    const media = payload.media;
    if (!media.localPath || (media.kind !== "image" && media.kind !== "file")) {
      throw new Error("Durable media delivery payload is invalid");
    }
  }
  const json = JSON.stringify(payload);
  if (Buffer.byteLength(json, "utf8") > 96 * 1_024) {
    throw new Error("Durable delivery payload is too large");
  }
}

function parsePayload(value: unknown): DurableDeliveryPayload {
  if (typeof value !== "string") throw new Error("Stored outbox payload is invalid");
  const parsed = JSON.parse(value) as unknown;
  const record = asRecord(parsed);
  if (!record || (record.kind !== "text" && record.kind !== "media")) {
    throw new Error("Stored outbox payload kind is invalid");
  }
  const payload = parsed as DurableDeliveryPayload;
  validatePayload(payload);
  return payload;
}

function parseJsonObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "string") throw new Error(`Stored ${label} is invalid`);
  const record = asRecord(JSON.parse(value) as unknown);
  if (!record) throw new Error(`Stored ${label} is not an object`);
  return record;
}

function assertToken(value: string, maxLength: number, label: string): void {
  if (!value.trim() || value.length > maxLength || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`Durable ${label} is invalid`);
  }
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

function readOptionalInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function readAggregate(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined;
}
