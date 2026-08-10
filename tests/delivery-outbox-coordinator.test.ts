import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatTransport, IdempotentTextTransport, MediaTransport } from "../src/core/contracts.js";
import type { IncomingMessage, OutgoingMediaMessage, OutgoingMessage } from "../src/core/types.js";
import { DeliveryOutboxCoordinator } from "../src/service/delivery-outbox-coordinator.js";
import { SqliteGatewayStore } from "../src/storage/sqlite.js";

class IdempotentTransport implements ChatTransport, IdempotentTextTransport {
  readonly name = "idempotent-test";
  readonly attempts: Array<{ message: OutgoingMessage; key: string }> = [];
  failuresRemaining = 1;
  async start(_onMessage: (message: IncomingMessage) => Promise<void>): Promise<void> {}
  async send(_message: OutgoingMessage): Promise<void> {
    throw new Error("ordinary send must not be used");
  }
  async sendIdempotent(message: OutgoingMessage, key: string): Promise<void> {
    this.attempts.push({ message, key });
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new TypeError("transient secret-bearing detail must not persist");
    }
  }
  async stop(): Promise<void> {}
}

class UncertainTransport implements ChatTransport {
  readonly name = "uncertain-test";
  attempts = 0;
  async start(_onMessage: (message: IncomingMessage) => Promise<void>): Promise<void> {}
  async send(_message: OutgoingMessage): Promise<void> {
    this.attempts += 1;
    throw new Error("connection reset after request write");
  }
  async stop(): Promise<void> {}
}

class MediaProbeTransport implements ChatTransport, MediaTransport {
  readonly name = "media-probe";
  sends = 0;
  async start(_onMessage: (message: IncomingMessage) => Promise<void>): Promise<void> {}
  async send(_message: OutgoingMessage): Promise<void> {}
  async sendMedia(_message: OutgoingMediaMessage): Promise<void> { this.sends += 1; }
  async stop(): Promise<void> {}
}

afterEach(() => {
  vi.useRealTimers();
});

describe("DeliveryOutboxCoordinator", () => {
  it("retries an idempotent Feishu-like delivery across coordinator restart", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const directory = await mkdtemp(join(tmpdir(), "floral-delivery-coordinator-"));
    const store = await SqliteGatewayStore.open(join(directory, "gateway.sqlite"));
    try {
      const transport = new IdempotentTransport();
      const first = new DeliveryOutboxCoordinator(transport, store.outbox, {
        instanceId: "delivery-worker-1",
        leaseTtlMs: 1_000,
        baseRetryMs: 1_000,
        maxRetryMs: 4_000,
      });
      await first.start();
      const waiting = await first.sendText({
        conversationId: "oc_owner",
        text: "durable response",
        idempotencyKey: "reply:om_1",
      });
      expect(waiting.transaction).toMatchObject({ status: "waiting", attempt: 1 });
      expect(waiting.lastErrorCode).toBe("transport-typeerror");
      await first.stop();

      vi.setSystemTime(11_000);
      const restarted = new DeliveryOutboxCoordinator(transport, store.outbox, {
        instanceId: "delivery-worker-2",
        leaseTtlMs: 1_000,
        baseRetryMs: 1_000,
      });
      await restarted.start();

      expect(transport.attempts).toHaveLength(2);
      expect(transport.attempts.map((attempt) => attempt.key)).toEqual([
        "reply:om_1",
        "reply:om_1",
      ]);
      expect(store.outbox.require(waiting.id)).toMatchObject({
        transaction: { status: "completed", attempt: 2 },
        acknowledgement: { transport: "idempotent-test" },
      });
      await restarted.stop();
    } finally {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not automatically duplicate an ambiguous non-idempotent send", async () => {
    const directory = await mkdtemp(join(tmpdir(), "floral-delivery-uncertain-"));
    const store = await SqliteGatewayStore.open(join(directory, "gateway.sqlite"));
    try {
      const transport = new UncertainTransport();
      const coordinator = new DeliveryOutboxCoordinator(transport, store.outbox, {
        instanceId: "delivery-worker",
        leaseTtlMs: 1_000,
      });
      await coordinator.start();
      const failed = await coordinator.sendText({
        conversationId: "conversation",
        text: "only once",
        idempotencyKey: "reply:message-1",
      });

      expect(transport.attempts).toBe(1);
      expect(failed.transaction.status).toBe("failed");
      await coordinator.drain();
      expect(transport.attempts).toBe(1);
      await coordinator.stop();
    } finally {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("quarantines an interrupted media send instead of replaying it after restart", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const directory = await mkdtemp(join(tmpdir(), "floral-delivery-media-recovery-"));
    const store = await SqliteGatewayStore.open(join(directory, "gateway.sqlite"));
    try {
      const queued = store.outbox.enqueue({
        idempotencyKey: "artifact:conversation:image-1",
        conversationId: "conversation",
        payload: {
          kind: "media",
          media: { kind: "image", localPath: "/private/image.png" },
        },
      });
      expect(store.outbox.claimNext("dead-worker", 1_000, 10_000)).toBeDefined();
      vi.setSystemTime(11_000);
      const transport = new MediaProbeTransport();
      const coordinator = new DeliveryOutboxCoordinator(transport, store.outbox, {
        instanceId: "recovery-worker",
        leaseTtlMs: 1_000,
      });
      await coordinator.start();

      expect(transport.sends).toBe(0);
      expect(store.outbox.require(queued.id)).toMatchObject({
        lastErrorCode: "ambiguous-recovery-non-idempotent",
        transaction: { status: "failed", attempt: 1 },
      });
      await coordinator.stop();
    } finally {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
