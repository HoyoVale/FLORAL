import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteGatewayStore } from "../src/storage/sqlite.js";

const message = {
  id: "om_queued",
  identity: {
    transport: "feishu" as const,
    botId: "cli_floral",
    externalUserId: "ou_owner",
    conversationId: "oc_owner",
  },
  text: "inspect the attached report",
  attachments: [{
    id: "file:report",
    kind: "file" as const,
    fileName: "report.pdf",
    localPath: "/private/floral/report.pdf",
    byteLength: 123,
    source: {
      transport: "feishu" as const,
      messageId: "om_queued",
      resourceKey: "file_report",
    },
  }],
  receivedAt: new Date("2026-08-10T12:00:00.000Z"),
};

const resolved = {
  userId: "owner-1",
  role: "owner" as const,
  conversationId: "conversation-1",
};

describe("DurableRunQueueStore", () => {
  it("persists a materialized queued run and deduplicates the inbound message", async () => {
    const directory = await mkdtemp(join(tmpdir(), "floral-run-queue-"));
    const path = join(directory, "gateway.sqlite");
    try {
      const first = await SqliteGatewayStore.open(path);
      const queued = first.runQueue.enqueue({ message, resolved });
      const duplicate = first.runQueue.enqueue({
        message: { ...message, text: "duplicate must not replace payload" },
        resolved,
      });
      expect(duplicate.id).toBe(queued.id);
      expect(duplicate.message.text).toBe(message.text);
      expect(first.runQueue.pendingCount("conversation-1")).toBe(1);
      await first.close();

      const reopened = await SqliteGatewayStore.open(path);
      const claimed = reopened.runQueue.claimNext("worker-1", 1_000, "conversation-1", 10_000);
      expect(claimed).toMatchObject({
        id: queued.id,
        message: {
          receivedAt: new Date("2026-08-10T12:00:00.000Z"),
          attachments: [{ localPath: "/private/floral/report.pdf" }],
        },
        transaction: { status: "executing", attempt: 1 },
      });
      reopened.runQueue.markCompleted(queued.id, { threadId: "thread-1" });
      expect(reopened.runQueue.diagnostics()).toEqual({
        pending: 0,
        executing: 0,
        failed: 0,
        completed: 1,
      });
      await reopened.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("recovers an expired lease and supports cancelling pending runs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "floral-run-recovery-"));
    const store = await SqliteGatewayStore.open(join(directory, "gateway.sqlite"));
    try {
      const first = store.runQueue.enqueue({ message, resolved });
      store.runQueue.enqueue({
        message: { ...message, id: "om_second", attachments: undefined },
        resolved,
      });
      expect(store.runQueue.claimById(first.id, "dead-worker", 1_000, 10_000)).toBeDefined();
      const recovered = store.runQueue.recoverExpiredLeases(11_000);
      expect(recovered[0]?.transaction).toMatchObject({
        status: "waiting",
        errorCode: "lease-expired",
      });
      expect(store.runQueue.cancelPending("conversation-1")).toBe(2);
      expect(store.runQueue.pendingCount("conversation-1")).toBe(0);
    } finally {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects remote-only attachment references before durable acknowledgement", async () => {
    const directory = await mkdtemp(join(tmpdir(), "floral-run-attachment-"));
    const store = await SqliteGatewayStore.open(join(directory, "gateway.sqlite"));
    try {
      expect(() => store.runQueue.enqueue({
        message: {
          ...message,
          attachments: message.attachments.map(({ localPath: _, ...attachment }) => attachment),
        },
        resolved,
      })).toThrow(/materialized/u);
    } finally {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
