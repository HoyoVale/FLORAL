import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteGatewayStore } from "../src/storage/sqlite.js";

describe("DurableOutboxStore", () => {
  it("deduplicates, leases, acknowledges, and persists a text delivery", async () => {
    const directory = await mkdtemp(join(tmpdir(), "floral-outbox-"));
    const path = join(directory, "gateway.sqlite");
    try {
      const first = await SqliteGatewayStore.open(path);
      const queued = first.outbox.enqueue({
        idempotencyKey: "reply:message-1",
        conversationId: "conversation-1",
        correlationId: "message-1",
        payload: { kind: "text", text: "hello" },
      });
      const duplicate = first.outbox.enqueue({
        idempotencyKey: "reply:message-1",
        conversationId: "conversation-1",
        payload: { kind: "text", text: "ignored duplicate" },
      });
      expect(duplicate.id).toBe(queued.id);
      expect(first.outbox.diagnostics()).toMatchObject({ pending: 1, delivered: 0 });

      const leased = first.outbox.claimNext("worker-1", 10_000, 1_000);
      expect(leased).toMatchObject({
        id: queued.id,
        payload: { kind: "text", text: "hello" },
        transaction: { status: "executing", attempt: 1 },
      });
      first.outbox.markDelivered(queued.id, { transportMessageId: "om_1" }, 2_000);
      expect(first.outbox.require(queued.id)).toMatchObject({
        deliveredAt: 2_000,
        acknowledgement: { transportMessageId: "om_1" },
        transaction: { status: "completed" },
      });
      await first.close();

      const reopened = await SqliteGatewayStore.open(path);
      expect(reopened.outbox.require(queued.id)).toMatchObject({
        deliveredAt: 2_000,
        transaction: { status: "completed" },
      });
      expect(reopened.outbox.claimNext("worker-2", 10_000, 3_000)).toBeUndefined();
      await reopened.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("schedules bounded retry and exposes terminal failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "floral-outbox-retry-"));
    const store = await SqliteGatewayStore.open(join(directory, "gateway.sqlite"));
    try {
      const queued = store.outbox.enqueue({
        idempotencyKey: "reply:message-2",
        conversationId: "conversation-2",
        payload: { kind: "text", text: "retry me" },
        maxAttempts: 2,
      });
      expect(store.outbox.claimNext("worker-1", 1_000, 10_000)).toBeDefined();
      store.outbox.markAttemptFailed(queued.id, "network", { retryAt: 20_000 });
      expect(store.outbox.claimNext("worker-1", 1_000, 19_999)).toBeUndefined();
      expect(store.outbox.claimNext("worker-1", 1_000, 20_000)).toBeDefined();
      store.outbox.markAttemptFailed(queued.id, "network");
      expect(store.outbox.require(queued.id)).toMatchObject({
        lastErrorCode: "network",
        transaction: { status: "failed", attempt: 2 },
      });
      expect(store.outbox.diagnostics()).toMatchObject({
        pending: 0,
        delivered: 0,
        failed: 1,
      });
    } finally {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
