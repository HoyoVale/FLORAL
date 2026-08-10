import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SqliteDatabase, SqliteStatement } from "../src/storage/sqlite.js";
import { DurableStateStore } from "../src/storage/durable-state.js";
import { SqliteGatewayStore, openApplicationDatabase } from "../src/storage/sqlite.js";

describe("durable storage fault boundaries", () => {
  it("fails without state advance when SQLite remains busy", async () => {
    const directory = await mkdtemp(join(tmpdir(), "floral-sqlite-busy-"));
    const path = join(directory, "gateway.sqlite");
    const store = await SqliteGatewayStore.open(path, { busyTimeoutMs: 50 });
    const locker = await openApplicationDatabase(path, { busyTimeoutMs: 50 });
    try {
      locker.exec("BEGIN IMMEDIATE");
      expect(() => store.durability.createTransaction({
        kind: "agent-run",
        idempotencyKey: "busy-injection",
      })).toThrow();
      expect(store.durability.findByIdempotency("agent-run", "busy-injection")).toBeUndefined();
    } finally {
      locker.exec("ROLLBACK");
      locker.close();
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses a corrupt or unavailable database before readiness", async () => {
    const directory = await mkdtemp(join(tmpdir(), "floral-sqlite-corrupt-"));
    const corrupt = join(directory, "corrupt.sqlite");
    const unavailable = join(directory, "database-directory");
    try {
      await writeFile(corrupt, "not a sqlite database");
      await mkdir(unavailable);
      await expect(SqliteGatewayStore.open(corrupt)).rejects.toThrow();
      await expect(SqliteGatewayStore.open(unavailable)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("propagates SQLITE_FULL before a transaction can be acknowledged", () => {
    const fault = Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" });
    const statement: SqliteStatement = {
      get: () => undefined,
      all: () => [],
      run: () => { throw fault; },
    };
    const db: SqliteDatabase = {
      exec: () => undefined,
      prepare: () => statement,
      transaction: (operation) => operation,
      close: () => undefined,
    };
    const durability = new DurableStateStore(db);
    expect(() => durability.createTransaction({
      kind: "agent-run",
      idempotencyKey: "disk-full-injection",
    })).toThrow(expect.objectContaining({ code: "SQLITE_FULL" }));
  });
});
