import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteGatewayStore } from "../src/storage/sqlite.js";

const RUNS = 160;
const DELIVERIES = 160;

describe("Phase 8G bounded durability soak", () => {
  it("drains sustained run and delivery journals without loss or duplication", async () => {
    const directory = await mkdtemp(join(tmpdir(), "floral-reliability-soak-"));
    const path = join(directory, "gateway.sqlite");
    try {
      const store = await SqliteGatewayStore.open(path);
      for (let index = 0; index < RUNS; index += 1) {
        const conversation = `conversation-${String(index % 8)}`;
        store.runQueue.enqueue({
          message: {
            id: `message-${String(index)}`,
            identity: {
              transport: "mock",
              botId: "soak-bot",
              externalUserId: "owner",
              conversationId: conversation,
            },
            text: `task ${String(index)}`,
            receivedAt: new Date(1_000 + index),
          },
          resolved: {
            userId: "owner",
            role: "owner",
            conversationId: conversation,
          },
        });
      }
      const seenRuns = new Set<string>();
      while (true) {
        const record = store.runQueue.claimNext("soak-runner", 10_000);
        if (!record) break;
        expect(seenRuns.has(record.id)).toBe(false);
        seenRuns.add(record.id);
        store.runQueue.markCompleted(record.id, { soak: true });
      }
      expect(seenRuns.size).toBe(RUNS);

      for (let index = 0; index < DELIVERIES; index += 1) {
        store.outbox.enqueue({
          idempotencyKey: `soak-delivery:${String(index)}`,
          conversationId: `conversation-${String(index % 8)}`,
          payload: { kind: "text", text: `result ${String(index)}` },
        });
      }
      const seenDeliveries = new Set<string>();
      while (true) {
        const record = store.outbox.claimNext("soak-delivery", 10_000);
        if (!record) break;
        expect(seenDeliveries.has(record.id)).toBe(false);
        seenDeliveries.add(record.id);
        store.outbox.markDelivered(record.id, { soak: true });
      }
      expect(seenDeliveries.size).toBe(DELIVERIES);
      expect(store.runQueue.diagnostics()).toEqual({
        pending: 0,
        executing: 0,
        failed: 0,
        completed: RUNS,
      });
      expect(store.outbox.diagnostics()).toMatchObject({
        pending: 0,
        delivered: DELIVERIES,
        failed: 0,
      });
      await store.close();

      const reopened = await SqliteGatewayStore.open(path);
      expect(reopened.durability.diagnostics()).toMatchObject({
        transactions: RUNS + DELIVERIES,
        recoverable: 0,
        executing: 0,
        terminalFailed: 0,
      });
      expect(reopened.runQueue.pendingConversations()).toEqual([]);
      expect(reopened.outbox.listPending()).toEqual([]);
      await reopened.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
