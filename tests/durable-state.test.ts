import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteGatewayStore } from "../src/storage/sqlite.js";

describe("DurableStateStore", () => {
  it("persists an event-sourced transaction lifecycle across reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "floral-durable-state-"));
    const path = join(directory, "gateway.sqlite");
    try {
      const first = await SqliteGatewayStore.open(path);
      const created = first.durability.createTransaction({
        kind: "agent-run",
        idempotencyKey: "feishu:message-1",
        correlationId: "message-1",
        conversationId: "conversation-1",
        projectId: "project-1",
        payload: { textHash: "abc" },
      });
      const duplicate = first.durability.createTransaction({
        kind: "agent-run",
        idempotencyKey: "feishu:message-1",
        payload: { textHash: "different" },
      });
      expect(duplicate.id).toBe(created.id);

      first.durability.transition(created.id, {
        status: "accepted",
        eventType: "run.accepted",
      });
      const executing = first.durability.acquireLease(
        created.id,
        "instance-a",
        30_000,
        1_000,
      );
      expect(executing).toMatchObject({
        status: "executing",
        attempt: 1,
        leaseOwner: "instance-a",
        leaseExpiresAt: 31_000,
      });
      first.durability.transition(created.id, {
        status: "completed",
        eventType: "run.completed",
        result: { threadId: "thread-1" },
      });
      expect(first.durability.listEvents(created.id).map((event) => event.eventType))
        .toEqual([
          "transaction.created",
          "run.accepted",
          "transaction.lease-acquired",
          "run.completed",
        ]);
      await first.close();

      const reopened = await SqliteGatewayStore.open(path);
      expect(reopened.durability.requireTransaction(created.id)).toMatchObject({
        status: "completed",
        attempt: 1,
        result: { threadId: "thread-1" },
      });
      expect(reopened.durability.diagnostics()).toMatchObject({
        transactions: 1,
        events: 4,
        recoverable: 0,
        executing: 0,
      });
      await reopened.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("recovers expired leases and stops after the retry budget", async () => {
    const directory = await mkdtemp(join(tmpdir(), "floral-durable-lease-"));
    const path = join(directory, "gateway.sqlite");
    const store = await SqliteGatewayStore.open(path);
    try {
      const transaction = store.durability.createTransaction({
        kind: "delivery",
        idempotencyKey: "delivery-1",
        maxAttempts: 2,
      });
      store.durability.transition(transaction.id, {
        status: "accepted",
        eventType: "delivery.queued",
      });
      expect(store.durability.acquireLease(transaction.id, "worker-a", 1_000, 10_000))
        .toMatchObject({ attempt: 1 });
      expect(store.durability.recoverExpiredLeases(11_001)).toEqual([
        expect.objectContaining({ status: "waiting", errorCode: "lease-expired" }),
      ]);
      expect(store.durability.listRecoverable(10, 11_001)).toHaveLength(1);

      expect(store.durability.acquireLease(transaction.id, "worker-b", 1_000, 12_000))
        .toMatchObject({ attempt: 2 });
      expect(store.durability.recoverExpiredLeases(13_001)).toEqual([
        expect.objectContaining({
          status: "failed",
          errorCode: "lease-expired-retry-limit",
        }),
      ]);
      expect(store.durability.listRecoverable(10, 13_001)).toHaveLength(0);
    } finally {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("enforces the lifecycle and lease ownership contracts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "floral-durable-contract-"));
    const store = await SqliteGatewayStore.open(join(directory, "gateway.sqlite"));
    try {
      const transaction = store.durability.createTransaction({ kind: "context" });
      expect(() => store.durability.transition(transaction.id, {
        status: "completed",
        eventType: "context.completed",
      })).toThrow("Invalid durable transaction transition");

      store.durability.transition(transaction.id, {
        status: "accepted",
        eventType: "context.accepted",
      });
      expect(store.durability.acquireLease(transaction.id, "worker-a", 5_000, 10_000))
        .toBeDefined();
      expect(store.durability.acquireLease(transaction.id, "worker-b", 5_000, 10_100))
        .toBeUndefined();
      expect(store.durability.renewLease(transaction.id, "worker-b", 5_000, 10_100))
        .toBe(false);
      expect(store.durability.renewLease(transaction.id, "worker-a", 5_000, 10_100))
        .toBe(true);
    } finally {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
