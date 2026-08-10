import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StartupRecoveryCoordinator } from "../src/service/startup-recovery-coordinator.js";
import { SqliteGatewayStore } from "../src/storage/sqlite.js";

describe("StartupRecoveryCoordinator", () => {
  it("recovers all expired leases in one journalled startup transaction", async () => {
    const directory = await mkdtemp(join(tmpdir(), "floral-startup-recovery-"));
    const store = await SqliteGatewayStore.open(join(directory, "gateway.sqlite"));
    try {
      const delivery = store.outbox.enqueue({
        idempotencyKey: "reply:recovery",
        conversationId: "delivery",
        payload: { kind: "text", text: "recover delivery" },
      });
      store.outbox.claimNext("dead-delivery", 1_000, 1_000);
      const run = store.runQueue.enqueue({
        message: {
          id: "message-recovery",
          identity: {
            transport: "mock",
            botId: "bot",
            externalUserId: "owner",
            conversationId: "delivery",
          },
          text: "recover run",
          receivedAt: new Date(1_000),
        },
        resolved: {
          userId: "owner",
          role: "owner",
          conversationId: "conversation",
        },
      });
      store.runQueue.claimById(run.id, "dead-run", 1_000, 1_000);

      const originalNow = Date.now;
      Date.now = () => 2_000;
      try {
        const coordinator = new StartupRecoveryCoordinator(
          store.durability,
          store.outbox,
          store.runQueue,
        );
        const snapshot = coordinator.recover();
        expect(snapshot).toMatchObject({
          recoveredLeases: 2,
          recoveredDeliveries: 1,
          recoveredAgentRuns: 1,
          deliveryPending: 2,
          runPending: 0,
          runFailed: 1,
        });
        expect(coordinator.latest()).toEqual(snapshot);
        expect(store.outbox.require(delivery.id).transaction.status).toBe("waiting");
        expect(store.runQueue.require(run.id).transaction).toMatchObject({
          status: "failed",
          errorCode: "ambiguous-interrupted-run",
        });
        expect(store.outbox.listPending()).toContainEqual(expect.objectContaining({
          idempotencyKey: `recovery-notice:agent-run:${run.id}`,
          conversationId: "delivery",
          payload: expect.objectContaining({ kind: "text" }),
        }));
        expect(store.durability.listEvents(snapshot.transactionId).at(-1)).toMatchObject({
          eventType: "recovery.completed",
          toStatus: "completed",
        });
      } finally {
        Date.now = originalNow;
      }
    } finally {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
