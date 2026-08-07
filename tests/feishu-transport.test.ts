import { describe, expect, it } from "vitest";
import { FeishuTransport, splitFeishuText } from "../src/transport/feishu/feishu-transport.js";
import type {
  FeishuWorkerConfig,
  FeishuWorkerMessage,
} from "../src/transport/feishu/feishu-worker-protocol.js";
import type { FeishuWorkerLike } from "../src/transport/feishu/feishu-transport.js";

class FakeWorker implements FeishuWorkerLike {
  readonly #messageListeners: Array<(message: FeishuWorkerMessage) => void> = [];
  readonly #errorListeners: Array<(error: Error) => void> = [];
  readonly #exitListeners: Array<(code: number) => void> = [];
  readonly #messageListenerReady = deferred<void>();
  terminated = false;

  on(event: "message", listener: (message: FeishuWorkerMessage) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (code: number) => void): this;
  on(
    event: "message" | "error" | "exit",
    listener: ((message: FeishuWorkerMessage) => void)
      | ((error: Error) => void)
      | ((code: number) => void),
  ): this {
    if (event === "message") {
      this.#messageListeners.push(listener as (message: FeishuWorkerMessage) => void);
      this.#messageListenerReady.resolve(undefined);
    } else if (event === "error") {
      this.#errorListeners.push(listener as (error: Error) => void);
    } else {
      this.#exitListeners.push(listener as (code: number) => void);
    }
    return this;
  }

  async terminate(): Promise<number> {
    this.terminated = true;
    return 0;
  }

  async waitUntilMessageListenerRegistered(): Promise<void> {
    await this.#messageListenerReady.promise;
  }

  message(value: FeishuWorkerMessage): void {
    for (const listener of this.#messageListeners) listener(value);
  }

  error(value: Error): void {
    for (const listener of this.#errorListeners) listener(value);
  }

  exit(code: number): void {
    for (const listener of this.#exitListeners) listener(code);
  }
}

function options(input: {
  worker: FakeWorker;
  create?: (request: unknown) => Promise<unknown>;
  onFatal?: (error: Error) => void;
}) {
  return {
    appId: "cli_floral",
    appSecret: "local-secret",
    expectedSdkVersion: "1.36.0",
    startupTimeoutMs: 1_000,
    outboundTimeoutMs: 1_000,
    textChunkBytes: 32,
    maxReplyChunks: 4,
    resolveInstalledSdkVersion: async () => "1.36.0",
    createWorker: (_config: FeishuWorkerConfig) => input.worker,
    createClient: () => ({
      im: {
        v1: {
          message: {
            create: input.create ?? (async () => ({ code: 0 })),
          },
        },
      },
    }),
    ...(input.onFatal ? { onFatal: input.onFatal } : {}),
  };
}

async function startTransport(
  transport: FeishuTransport,
  worker: FakeWorker,
  onMessage: Parameters<FeishuTransport["start"]>[0] = async () => undefined,
): Promise<void> {
  const starting = transport.start(onMessage);
  await worker.waitUntilMessageListenerRegistered();
  worker.message({ type: "started" });
  await starting;
}

describe("FeishuTransport", () => {
  it("starts after worker initialization and terminates the worker on stop", async () => {
    const worker = new FakeWorker();
    const transport = new FeishuTransport(options({ worker }));

    await startTransport(transport, worker);
    await transport.stop();

    expect(worker.terminated).toBe(true);
  });

  it("dispatches Feishu worker messages into the transport-neutral inbound contract", async () => {
    const worker = new FakeWorker();
    const received: unknown[] = [];
    const transport = new FeishuTransport(options({ worker }));
    await startTransport(transport, worker, async (message) => {
      received.push(message);
    });

    worker.message({
      type: "message",
      message: {
        id: "om_message",
        botId: "cli_floral",
        externalUserId: "ou_owner",
        conversationId: "oc_chat",
        text: "/status",
        receivedAtMs: 1_786_123_456_789,
      },
    });
    await Promise.resolve();

    expect(received).toEqual([{
      id: "om_message",
      identity: {
        transport: "feishu",
        botId: "cli_floral",
        externalUserId: "ou_owner",
        conversationId: "oc_chat",
      },
      text: "/status",
      receivedAt: new Date(1_786_123_456_789),
    }]);
    await transport.stop();
  });

  it("sends text by chat_id and serializes concurrent sends in one conversation", async () => {
    const worker = new FakeWorker();
    const requests: unknown[] = [];
    const gates = [deferred<void>(), deferred<void>()];
    const requestStarted = [deferred<void>(), deferred<void>()];
    let call = 0;
    const transport = new FeishuTransport(options({
      worker,
      create: async (request) => {
        const index = call++;
        requests.push(request);
        requestStarted[index]?.resolve(undefined);
        await gates[index]?.promise;
        return { code: 0 };
      },
    }));
    await startTransport(transport, worker);

    const first = transport.send({ conversationId: "oc_chat", text: "first" });
    const second = transport.send({ conversationId: "oc_chat", text: "second" });
    await requestStarted[0]!.promise;
    expect(requests).toHaveLength(1);

    gates[0]?.resolve(undefined);
    await first;
    await requestStarted[1]!.promise;
    expect(requests).toHaveLength(2);

    gates[1]?.resolve(undefined);
    await second;
    expect(requests[0]).toEqual({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: "oc_chat",
        msg_type: "text",
        content: JSON.stringify({ text: "first" }),
      },
    });
    await transport.stop();
  });

  it("sends a native approval card and routes a matching callback through the command path", async () => {
    const worker = new FakeWorker();
    const requests: unknown[] = [];
    const callbackReceived = deferred<void>();
    const received: unknown[] = [];
    const transport = new FeishuTransport(options({
      worker,
      create: async (request) => {
        requests.push(request);
        return { code: 0 };
      },
    }));
    await startTransport(transport, worker, async (message) => {
      received.push(message);
      if (message.id.startsWith("feishu-card-action:")) {
        callbackReceived.resolve(undefined);
      }
    });

    worker.message({
      type: "message",
      message: {
        id: "om_request",
        botId: "cli_floral",
        externalUserId: "ou_owner",
        conversationId: "oc_chat",
        text: "please patch",
        receivedAtMs: 1_786_123_456_000,
      },
    });

    await transport.sendInteractiveApprovalPrompt({
      conversationId: "oc_chat",
      approvalId: "ABCDEF123456",
      capability: "files.write",
      summary: "write phase5f3b-test.txt",
      ttlMs: 60_000,
    });

    expect(requests).toHaveLength(1);
    const request = requests[0] as {
      params?: { receive_id_type?: unknown };
      data?: {
        receive_id?: unknown;
        msg_type?: unknown;
        content?: string;
      };
    };
    expect(request.params?.receive_id_type).toBe("chat_id");
    expect(request.data?.receive_id).toBe("oc_chat");
    expect(request.data?.msg_type).toBe("interactive");
    const card = JSON.parse(request.data?.content ?? "{}") as { schema?: unknown };
    expect(card.schema).toBe("2.0");

    worker.message({
      type: "card-action",
      action: {
        eventId: "evt_approve",
        externalUserId: "ou_owner",
        conversationId: "oc_chat",
        approvalId: "ABCDEF123456",
        decision: "approve",
        receivedAtMs: 1_786_123_456_789,
      },
    });
    await callbackReceived.promise;

    expect(received.at(-1)).toEqual({
      id: "feishu-card-action:evt_approve",
      identity: {
        transport: "feishu",
        botId: "cli_floral",
        externalUserId: "ou_owner",
        conversationId: "oc_chat",
      },
      text: "/approve ABCDEF123456",
      receivedAt: new Date(1_786_123_456_789),
    });
    await transport.stop();
  });

  it("fails closed when an approval callback user or conversation does not match the route", async () => {
    const worker = new FakeWorker();
    const received: unknown[] = [];
    const transport = new FeishuTransport(options({ worker }));
    await startTransport(transport, worker, async (message) => {
      received.push(message);
    });

    worker.message({
      type: "message",
      message: {
        id: "om_request",
        botId: "cli_floral",
        externalUserId: "ou_owner",
        conversationId: "oc_chat",
        text: "please patch",
        receivedAtMs: 1_786_123_456_000,
      },
    });
    await transport.sendInteractiveApprovalPrompt({
      conversationId: "oc_chat",
      approvalId: "ABCDEF123456",
      capability: "files.write",
      summary: "write",
      ttlMs: 60_000,
    });
    const baseline = received.length;

    worker.message({
      type: "card-action",
      action: {
        eventId: "evt_foreign",
        externalUserId: "ou_attacker",
        conversationId: "oc_chat",
        approvalId: "ABCDEF123456",
        decision: "approve",
        receivedAtMs: 1_786_123_456_789,
      },
    });
    worker.message({
      type: "card-action",
      action: {
        eventId: "evt_wrong_chat",
        externalUserId: "ou_owner",
        conversationId: "oc_other",
        approvalId: "ABCDEF123456",
        decision: "approve",
        receivedAtMs: 1_786_123_456_790,
      },
    });
    await Promise.resolve();

    expect(received).toHaveLength(baseline);
    await transport.stop();
  });

  it("falls back safely when no inbound identity route exists for an approval card", async () => {
    const worker = new FakeWorker();
    const transport = new FeishuTransport(options({ worker }));
    await startTransport(transport, worker);

    await expect(transport.sendInteractiveApprovalPrompt({
      conversationId: "oc_chat",
      approvalId: "ABCDEF123456",
      capability: "files.write",
      summary: "write",
      ttlMs: 60_000,
    })).rejects.toThrow("route is unavailable");

    await transport.stop();
  });

  it("reports an unexpected post-start worker failure to the service supervisor hook", async () => {
    const worker = new FakeWorker();
    const fatal: Error[] = [];
    const transport = new FeishuTransport(options({
      worker,
      onFatal: (error) => fatal.push(error),
    }));
    await startTransport(transport, worker);

    worker.exit(7);

    expect(fatal[0]?.message).toContain("code 7");
    await transport.stop();
  });

  it("fails startup closed when the worker reports a fatal error", async () => {
    const worker = new FakeWorker();
    const transport = new FeishuTransport(options({ worker }));
    const starting = transport.start(async () => undefined);
    await worker.waitUntilMessageListenerRegistered();

    worker.message({ type: "fatal", errorType: "AuthenticationError" });

    await expect(starting).rejects.toThrow("AuthenticationError");
    expect(worker.terminated).toBe(true);
  });

  it("chunks by UTF-8 bytes without splitting Unicode and truncates only after maxChunks", () => {
    expect(splitFeishuText("你好abc", 7, 4)).toEqual(["你好a", "bc"]);

    const chunks = splitFeishuText("abcdefghijklmnop", 6, 2, "[..]");
    expect(chunks).toEqual(["abcdef", "gh[..]"]);
    expect(chunks.every((chunk) => Buffer.byteLength(chunk, "utf8") <= 6)).toBe(true);
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
