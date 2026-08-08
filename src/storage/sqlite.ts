import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  GatewayStore,
  WorkspaceStateStore,
} from "../core/contracts.js";
import type {
  AuditEventInput,
  ExternalIdentity,
  GatewayRole,
  ResolvedGatewayIdentity,
  TransportKind,
} from "../core/types.js";

interface SqliteRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

interface SqliteStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): SqliteRunResult;
}

interface SqliteDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): SqliteStatement;
  transaction<T>(fn: () => T): () => T;
  close(): void;
}

export interface GatewayStorageDiagnostics {
  schemaVersion: number;
  users: number;
  identities: number;
  conversations: number;
  conversationProjects: number;
  messageReceipts: number;
  auditEvents: number;
  owners: number;
}

export class SqliteGatewayStore implements GatewayStore, WorkspaceStateStore {
  #closed = false;

  private constructor(private readonly db: SqliteDatabase) {}

  static async open(path: string): Promise<SqliteGatewayStore> {
    const db = await openApplicationDatabase(path);
    migrateGatewaySchema(db);
    return new SqliteGatewayStore(db);
  }

  async resolveIdentity(
    identity: ExternalIdentity,
  ): Promise<ResolvedGatewayIdentity | undefined> {
    this.#assertOpen();
    assertExternalIdentity(identity);
    const row = asRecord(this.db.prepare(`
      SELECT
        u.id AS user_id,
        u.role AS role
      FROM external_identities AS e
      JOIN users AS u ON u.id = e.user_id
      WHERE e.provider = ? AND e.bot_id = ? AND e.external_user_id = ?
      LIMIT 1
    `).get(identity.transport, identity.botId, identity.externalUserId));

    if (!row) return undefined;
    const userId = requireString(row.user_id, "external identity user_id");
    const role = requireRole(row.role);
    const now = Date.now();

    this.db.prepare(`
      UPDATE external_identities
      SET updated_at = ?
      WHERE provider = ? AND bot_id = ? AND external_user_id = ?
    `).run(
      now,
      identity.transport,
      identity.botId,
      identity.externalUserId,
    );

    const conversationId = ensureConversation(this.db, userId, identity, now);
    return { userId, role, conversationId };
  }

  async claimOwner(identity: ExternalIdentity): Promise<ResolvedGatewayIdentity> {
    this.#assertOpen();
    assertExternalIdentity(identity);
    return this.db.transaction(() => {
      const existing = asRecord(this.db.prepare(`
        SELECT u.id AS user_id, u.role AS role
        FROM external_identities AS e
        JOIN users AS u ON u.id = e.user_id
        WHERE e.provider = ? AND e.bot_id = ? AND e.external_user_id = ?
        LIMIT 1
      `).get(identity.transport, identity.botId, identity.externalUserId));

      const now = Date.now();
      if (existing) {
        const userId = requireString(existing.user_id, "external identity user_id");
        const role = requireRole(existing.role);
        if (role !== "owner") {
          throw new Error("Existing identity is not an owner");
        }

        const binding = asRecord(this.db.prepare(`
          SELECT user_id
          FROM owner_bindings
          WHERE provider = ? AND bot_id = ?
          LIMIT 1
        `).get(identity.transport, identity.botId));
        const boundUserId = readOptionalString(binding?.user_id);
        if (boundUserId && boundUserId !== userId) {
          throw new Error("This bot already has a different owner");
        }
        if (!boundUserId) {
          this.db.prepare(`
            INSERT INTO owner_bindings (
              provider, bot_id, user_id, created_at
            )
            VALUES (?, ?, ?, ?)
          `).run(identity.transport, identity.botId, userId, now);
        }

        const conversationId = ensureConversation(this.db, userId, identity, now);
        return { userId, role, conversationId };
      }

      const owner = asRecord(this.db.prepare(`
        SELECT user_id
        FROM owner_bindings
        WHERE provider = ? AND bot_id = ?
        LIMIT 1
      `).get(identity.transport, identity.botId));

      if (owner) {
        throw new Error("This bot already has an owner");
      }

      const userId = randomUUID();
      this.db.prepare(`
        INSERT INTO users (id, role, created_at, updated_at)
        VALUES (?, 'owner', ?, ?)
      `).run(userId, now, now);

      this.db.prepare(`
        INSERT INTO external_identities (
          id, user_id, provider, bot_id, external_user_id,
          created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        userId,
        identity.transport,
        identity.botId,
        identity.externalUserId,
        now,
        now,
      );

      this.db.prepare(`
        INSERT INTO owner_bindings (
          provider, bot_id, user_id, created_at
        )
        VALUES (?, ?, ?, ?)
      `).run(
        identity.transport,
        identity.botId,
        userId,
        now,
      );

      const conversationId = ensureConversation(this.db, userId, identity, now);
      return {
        userId,
        role: "owner" as const,
        conversationId,
      };
    })();
  }

  async hasOwner(transport: TransportKind, botId: string): Promise<boolean> {
    this.#assertOpen();
    const row = asRecord(this.db.prepare(`
      SELECT 1 AS present
      FROM owner_bindings
      WHERE provider = ? AND bot_id = ?
      LIMIT 1
    `).get(transport, botId));
    return row?.present === 1;
  }

  async acceptMessage(
    identity: ExternalIdentity,
    messageId: string,
    receivedAt: Date,
  ): Promise<boolean> {
    this.#assertOpen();
    assertExternalIdentity(identity);
    if (!messageId.trim()) throw new Error("Message id must not be empty");
    if (messageId.length > 512) throw new Error("Message id exceeds 512 characters");
    const receivedAtMs = receivedAt.getTime();
    if (!Number.isFinite(receivedAtMs)) throw new Error("Message receivedAt is invalid");
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO message_receipts (
        provider, bot_id, external_message_id, received_at
      )
      VALUES (?, ?, ?, ?)
    `).run(
      identity.transport,
      identity.botId,
      messageId,
      receivedAtMs,
    );

    if (result.changes === 1) {
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1_000;
      this.db.prepare(`
        DELETE FROM message_receipts
        WHERE received_at < ?
      `).run(cutoff);
      return true;
    }
    return false;
  }

  async getActiveThread(conversationId: string): Promise<string | undefined> {
    this.#assertOpen();
    const row = asRecord(this.db.prepare(`
      SELECT active_codex_thread_id
      FROM conversations
      WHERE id = ?
      LIMIT 1
    `).get(conversationId));
    return readOptionalString(row?.active_codex_thread_id);
  }

  async setActiveThread(conversationId: string, threadId: string): Promise<void> {
    this.#assertOpen();
    if (!threadId.trim()) throw new Error("Thread id must not be empty");
    const result = this.db.prepare(`
      UPDATE conversations
      SET active_codex_thread_id = ?, updated_at = ?
      WHERE id = ?
    `).run(threadId, Date.now(), conversationId);
    if (result.changes !== 1) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }
  }

  async clearActiveThread(conversationId: string): Promise<void> {
    this.#assertOpen();
    const result = this.db.prepare(`
      UPDATE conversations
      SET active_codex_thread_id = NULL, updated_at = ?
      WHERE id = ?
    `).run(Date.now(), conversationId);
    if (result.changes !== 1) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }
  }

  async getSelectedProject(conversationId: string): Promise<string | undefined> {
    this.#assertOpen();
    const row = asRecord(this.db.prepare(`
      SELECT selected_project_name
      FROM conversations
      WHERE id = ?
      LIMIT 1
    `).get(conversationId));
    return readOptionalString(row?.selected_project_name);
  }

  async setSelectedProject(
    conversationId: string,
    projectName: string,
  ): Promise<void> {
    this.#assertOpen();
    assertStoredProjectName(projectName);
    const now = Date.now();
    const update = this.db.prepare(`
      UPDATE conversations
      SET selected_project_name = ?, updated_at = ?
      WHERE id = ?
    `).run(projectName, now, conversationId);
    if (update.changes !== 1) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }
    this.db.prepare(`
      INSERT INTO conversation_project_state (
        conversation_id, project_name, active_codex_thread_id,
        created_at, updated_at
      )
      VALUES (?, ?, NULL, ?, ?)
      ON CONFLICT(conversation_id, project_name)
      DO UPDATE SET updated_at = excluded.updated_at
    `).run(conversationId, projectName, now, now);
  }

  async getProjectActiveThread(
    conversationId: string,
    projectName: string,
  ): Promise<string | undefined> {
    this.#assertOpen();
    assertStoredProjectName(projectName);
    const row = asRecord(this.db.prepare(`
      SELECT active_codex_thread_id
      FROM conversation_project_state
      WHERE conversation_id = ? AND project_name = ?
      LIMIT 1
    `).get(conversationId, projectName));
    return readOptionalString(row?.active_codex_thread_id);
  }

  async setProjectActiveThread(
    conversationId: string,
    projectName: string,
    threadId: string,
  ): Promise<void> {
    this.#assertOpen();
    assertStoredProjectName(projectName);
    if (!threadId.trim()) throw new Error("Thread id must not be empty");
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO conversation_project_state (
        conversation_id, project_name, active_codex_thread_id,
        created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(conversation_id, project_name)
      DO UPDATE SET
        active_codex_thread_id = excluded.active_codex_thread_id,
        updated_at = excluded.updated_at
    `).run(conversationId, projectName, threadId, now, now);
  }

  async clearProjectActiveThread(
    conversationId: string,
    projectName: string,
  ): Promise<void> {
    this.#assertOpen();
    assertStoredProjectName(projectName);
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO conversation_project_state (
        conversation_id, project_name, active_codex_thread_id,
        created_at, updated_at
      )
      VALUES (?, ?, NULL, ?, ?)
      ON CONFLICT(conversation_id, project_name)
      DO UPDATE SET
        active_codex_thread_id = NULL,
        updated_at = excluded.updated_at
    `).run(conversationId, projectName, now, now);
  }

  async appendAudit(event: AuditEventInput): Promise<void> {
    this.#assertOpen();
    if (!/^[a-z0-9_.-]{1,96}$/i.test(event.eventType)) {
      throw new Error(`Invalid audit event type: ${event.eventType}`);
    }
    const payloadJson = JSON.stringify(event.payload ?? {});
    if (Buffer.byteLength(payloadJson, "utf8") > 16 * 1_024) {
      throw new Error("Audit payload exceeds 16384 bytes");
    }
    const createdAtMs = (event.createdAt ?? new Date()).getTime();
    if (!Number.isFinite(createdAtMs)) {
      throw new Error("Audit createdAt is invalid");
    }
    this.db.prepare(`
      INSERT INTO audit_events (
        id, user_id, conversation_id, event_type, payload_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      event.userId ?? null,
      event.conversationId ?? null,
      event.eventType,
      payloadJson,
      createdAtMs,
    );
  }

  diagnostics(): GatewayStorageDiagnostics {
    this.#assertOpen();
    return {
      schemaVersion: readPragmaUserVersion(this.db),
      users: countRows(this.db, "users"),
      identities: countRows(this.db, "external_identities"),
      conversations: countRows(this.db, "conversations"),
      conversationProjects: countRows(this.db, "conversation_project_state"),
      messageReceipts: countRows(this.db, "message_receipts"),
      auditEvents: countRows(this.db, "audit_events"),
      owners: countRows(this.db, "owner_bindings"),
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.db.close();
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Gateway store is closed");
  }
}

export async function openApplicationDatabase(path: string): Promise<SqliteDatabase> {
  await mkdir(dirname(path), { recursive: true });
  const packageName = "better-sqlite3";
  const module = await import(packageName) as {
    default: new (path: string) => SqliteDatabase;
  };
  const db = new module.default(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
  return db;
}

function migrateGatewaySchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL CHECK(role IN ('owner', 'operator', 'viewer')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS owner_bindings (
      provider TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(provider, bot_id)
    );

    CREATE TABLE IF NOT EXISTS external_identities (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      external_user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(provider, bot_id, external_user_id)
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      transport TEXT NOT NULL,
      external_conversation_id TEXT NOT NULL,
      active_codex_thread_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      conversation_id TEXT,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS message_receipts (
      provider TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      external_message_id TEXT NOT NULL,
      received_at INTEGER NOT NULL,
      PRIMARY KEY(provider, bot_id, external_message_id)
    );
  `);

  ensureColumn(
    db,
    "external_identities",
    "updated_at",
    "INTEGER NOT NULL DEFAULT 0",
  );
  ensureColumn(
    db,
    "conversations",
    "bot_id",
    "TEXT NOT NULL DEFAULT ''",
  );
  ensureColumn(
    db,
    "conversations",
    "selected_project_name",
    "TEXT",
  );

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_project_state (
      conversation_id TEXT NOT NULL,
      project_name TEXT NOT NULL,
      active_codex_thread_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(conversation_id, project_name),
      FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );
  `);

  db.exec(`
    INSERT OR IGNORE INTO owner_bindings (
      provider, bot_id, user_id, created_at
    )
    SELECT e.provider, e.bot_id, e.user_id, MIN(e.created_at)
    FROM external_identities AS e
    JOIN users AS u ON u.id = e.user_id
    WHERE u.role = 'owner'
    GROUP BY e.provider, e.bot_id;

    CREATE UNIQUE INDEX IF NOT EXISTS conversations_transport_bot_external_idx
      ON conversations(transport, bot_id, external_conversation_id);

    CREATE INDEX IF NOT EXISTS audit_events_created_at_idx
      ON audit_events(created_at);

    CREATE INDEX IF NOT EXISTS audit_events_user_created_idx
      ON audit_events(user_id, created_at);

    PRAGMA user_version = 4;
  `);
}

function ensureColumn(
  db: SqliteDatabase,
  table: string,
  column: string,
  declaration: string,
): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all()
    .map(asRecord)
    .filter((value): value is Record<string, unknown> => value !== undefined);
  if (columns.some((entry) => entry.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
}

function ensureConversation(
  db: SqliteDatabase,
  userId: string,
  identity: ExternalIdentity,
  now: number,
): string {
  const existing = asRecord(db.prepare(`
    SELECT id, user_id
    FROM conversations
    WHERE transport = ? AND bot_id = ? AND external_conversation_id = ?
    LIMIT 1
  `).get(identity.transport, identity.botId, identity.conversationId));

  if (existing) {
    const assignedUserId = requireString(existing.user_id, "conversation user_id");
    if (assignedUserId !== userId) {
      throw new Error("Conversation is already assigned to another user");
    }
    const conversationId = requireString(existing.id, "conversation id");
    db.prepare(`
      UPDATE conversations SET updated_at = ? WHERE id = ?
    `).run(now, conversationId);
    return conversationId;
  }

  const conversationId = randomUUID();
  db.prepare(`
    INSERT INTO conversations (
      id, user_id, transport, bot_id, external_conversation_id,
      active_codex_thread_id, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
  `).run(
    conversationId,
    userId,
    identity.transport,
    identity.botId,
    identity.conversationId,
    now,
    now,
  );
  return conversationId;
}

function countRows(db: SqliteDatabase, table: string): number {
  return readCount(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get());
}

function readCount(value: unknown): number {
  const row = asRecord(value);
  const count = row?.count;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
    throw new Error("SQLite count query returned an invalid value");
  }
  return count;
}

function readPragmaUserVersion(db: SqliteDatabase): number {
  const row = asRecord(db.prepare("PRAGMA user_version").get());
  const version = row?.user_version;
  if (typeof version !== "number" || !Number.isSafeInteger(version)) {
    throw new Error("SQLite user_version is invalid");
  }
  return version;
}

function requireRole(value: unknown): GatewayRole {
  if (value === "owner" || value === "operator" || value === "viewer") {
    return value;
  }
  throw new Error("Stored gateway role is invalid");
}

function requireString(value: unknown, label: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(`${label} is missing`);
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function assertStoredProjectName(projectName: string): void {
  const normalized = projectName.trim();
  if (!normalized || Array.from(normalized).length > 96) {
    throw new Error("Stored project name is invalid");
  }
  if (/[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error("Stored project name contains control characters");
  }
}

function assertExternalIdentity(identity: ExternalIdentity): void {
  for (const [label, value] of [
    ["botId", identity.botId],
    ["externalUserId", identity.externalUserId],
    ["conversationId", identity.conversationId],
  ] as const) {
    if (!value.trim()) throw new Error(`External identity ${label} must not be empty`);
    if (value.length > 512) {
      throw new Error(`External identity ${label} exceeds 512 characters`);
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}
