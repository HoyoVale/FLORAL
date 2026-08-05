import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

interface SqliteDatabase {
  exec(sql: string): unknown;
  close(): void;
}

export async function openApplicationDatabase(path: string): Promise<SqliteDatabase> {
  await mkdir(dirname(path), { recursive: true });
  const packageName = "better-sqlite3";
  const module = await import(packageName) as { default: new (path: string) => SqliteDatabase };
  const db = new module.default(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

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
  `);
  return db;
}
