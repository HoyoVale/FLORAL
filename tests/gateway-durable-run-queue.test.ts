import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRuntime, ChatTransport } from "../src/core/contracts.js";
import type {
  AgentRunRequest,
  AgentRunResult,
  ExternalIdentity,
  IncomingAttachment,
  IncomingMessage,
  OutgoingMessage,
} from "../src/core/types.js";
import { DurableRunCoordinator } from "../src/service/durable-run-coordinator.js";
import { GatewayService } from "../src/service/gateway.js";
import { SqliteGatewayStore } from "../src/storage/sqlite.js";

const identity: ExternalIdentity = {
  transport: "mock",
  botId: "bot",
  externalUserId: "owner",
  conversationId: "delivery-conversation",
};

class TestTransport implements ChatTransport {
  readonly name = "test";
  readonly sent: OutgoingMessage[] = [];
  #onMessage: ((message: IncomingMessage) => Promise<void>) | undefined;
  async start(onMessage: (message: IncomingMessage) => Promise<void>): Promise<void> {
    this.#onMessage = onMessage;
  }
  async send(message: OutgoingMessage): Promise<void> { this.sent.push(message); }
  async stop(): Promise<void> {}
  async emit(text: string, id: string, attachments?: IncomingAttachment[]): Promise<void> {
    if (!this.#onMessage) throw new Error("transport not started");
    await this.#onMessage({
      id,
      identity,
      text,
      receivedAt: new Date(),
      ...(attachments ? { attachments } : {}),
    });
  }
}

class SerialRuntime implements AgentRuntime {
  readonly name = "serial";
  readonly requests: AgentRunRequest[] = [];
  readonly firstStarted = deferred<void>();
  readonly releaseFirst = deferred<void>();
  readonly secondCompleted = deferred<void>();
  active = 0;
  maximumActive = 0;
  async start(): Promise<void> {}
  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const index = this.requests.push(request);
    this.active += 1;
    this.maximumActive = Math.max(this.maximumActive, this.active);
    try {
      if (index === 1) {
        this.firstStarted.resolve(undefined);
        await this.releaseFirst.promise;
      }
      if (index === 2) this.secondCompleted.resolve(undefined);
      return { threadId: `thread-${String(index)}`, finalText: `done-${String(index)}` };
    } finally {
      this.active -= 1;
    }
  }
  async interrupt(): Promise<void> {}
  async stop(): Promise<void> {}
}

describe("Gateway durable run scheduling", () => {
  it("persists a busy-conversation message and executes it in FIFO order", async () => {
    const directory = await mkdtemp(join(tmpdir(), "floral-gateway-durable-run-"));
    const store = await SqliteGatewayStore.open(join(directory, "gateway.sqlite"));
    const transport = new TestTransport();
    const runtime = new SerialRuntime();
    const owner = await store.claimOwner(identity);
    const durableRuns = new DurableRunCoordinator(store.runQueue, {
      instanceId: "gateway-test",
      leaseTtlMs: 3_000,
    });
    const gateway = new GatewayService(transport, runtime, store, {
      cwd: process.cwd(),
      durableRuns,
    });
    try {
      await gateway.start();
      const first = transport.emit("first task", "message-1");
      await runtime.firstStarted.promise;
      await transport.emit("second task", "message-2");

      expect(store.runQueue.pendingCount(owner.conversationId)).toBe(1);
      expect(transport.sent.at(-1)?.text).toContain("已持久化排队");
      runtime.releaseFirst.resolve(undefined);
      await first;
      await runtime.secondCompleted.promise;
      await waitUntil(() => store.runQueue.diagnostics().completed === 2);

      expect(runtime.requests.map((request) => request.text)).toEqual([
        "first task",
        "second task",
      ]);
      expect(runtime.maximumActive).toBe(1);
      expect(store.runQueue.diagnostics()).toMatchObject({
        pending: 0,
        executing: 0,
        completed: 2,
      });
    } finally {
      runtime.releaseFirst.resolve(undefined);
      await gateway.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a disappeared queued attachment without starting the agent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "floral-gateway-missing-spool-"));
    const store = await SqliteGatewayStore.open(join(directory, "gateway.sqlite"));
    const transport = new TestTransport();
    const runtime = new SerialRuntime();
    await store.claimOwner(identity);
    const gateway = new GatewayService(transport, runtime, store, {
      cwd: process.cwd(),
      durableRuns: new DurableRunCoordinator(store.runQueue, {
        instanceId: "missing-spool-test",
        leaseTtlMs: 3_000,
      }),
    });
    try {
      await gateway.start();
      await transport.emit("inspect attachment", "missing-attachment", [{
        id: "attachment-1",
        kind: "file",
        fileName: "missing.txt",
        localPath: join(directory, "missing.txt"),
        byteLength: 5,
        source: {
          transport: "feishu",
          messageId: "missing-attachment",
          resourceKey: "resource-1",
        },
      }]);

      expect(runtime.requests).toHaveLength(0);
      expect(transport.sent.at(-1)?.text).toContain("附件已丢失");
      expect(store.runQueue.diagnostics()).toMatchObject({ completed: 1, failed: 0 });
    } finally {
      runtime.releaseFirst.resolve(undefined);
      await gateway.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("recovers work committed before the inbound receipt when acceptance is interrupted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "floral-gateway-acceptance-gap-"));
    const path = join(directory, "gateway.sqlite");
    try {
      const firstStore = await SqliteGatewayStore.open(path);
      const firstTransport = new TestTransport();
      const firstRuntime = new SerialRuntime();
      await firstStore.claimOwner(identity);
      Object.defineProperty(firstStore, "acceptMessage", {
        value: async () => { throw new Error("injected receipt interruption"); },
      });
      const firstGateway = new GatewayService(firstTransport, firstRuntime, firstStore, {
        cwd: process.cwd(),
        durableRuns: new DurableRunCoordinator(firstStore.runQueue, {
          instanceId: "acceptance-gap-1",
          leaseTtlMs: 3_000,
        }),
      });
      await firstGateway.start();
      await expect(firstTransport.emit("survive receipt crash", "acceptance-gap-message"))
        .rejects.toThrow("injected receipt interruption");
      expect(firstStore.runQueue.diagnostics().pending).toBe(1);
      await firstGateway.stop();

      const secondStore = await SqliteGatewayStore.open(path);
      const secondTransport = new TestTransport();
      const secondRuntime = new SerialRuntime();
      const secondGateway = new GatewayService(secondTransport, secondRuntime, secondStore, {
        cwd: process.cwd(),
        durableRuns: new DurableRunCoordinator(secondStore.runQueue, {
          instanceId: "acceptance-gap-2",
          leaseTtlMs: 3_000,
        }),
      });
      await secondGateway.start();
      await secondRuntime.firstStarted.promise;
      expect(secondRuntime.requests[0]?.text).toBe("survive receipt crash");
      secondRuntime.releaseFirst.resolve(undefined);
      await waitUntil(() => secondStore.runQueue.diagnostics().completed === 1);
      await secondGateway.stop();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition timed out");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
