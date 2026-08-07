import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "../src/core/types.js";
import {
  QqDeliveryError,
  QqReplyTargetUnavailableError,
  QqTransport,
} from "../src/transport/qq/qq-transport.js";

class FakeBot {
  readonly listeners = new Map<string, Array<(...args: unknown[]) => unknown>>();
  readonly sent: Array<{ target: Record<string, unknown>; text: string }> = [];
  readonly typing: Array<Record<string, unknown>> = [];
  readonly started = deferred<void>();
  readonly stopped = deferred<void>();
  signal: AbortSignal | undefined;
  sendError: Error | undefined;
  typingError: Error | undefined;
  nextSendGate: Promise<void> | undefined;

  on(event: string, listener: (...args: never[]) => unknown): void {
    const entries = this.listeners.get(event) ?? [];
    entries.push(listener as (...args: unknown[]) => unknown);
    this.listeners.set(event, entries);
  }

  async start(signal?: AbortSignal): Promise<void> {
    this.signal = signal;
    this.started.resolve(undefined);
    await this.stopped.promise;
  }

  async stop(): Promise<void> {
    this.stopped.resolve(undefined);
  }

  async sendText(
    target: Record<string, unknown>,
    text: string,
  ): Promise<Record<string, unknown>> {
    if (this.sendError) throw this.sendError;
    this.sent.push({ target, text });
    const gate = this.nextSendGate;
    this.nextSendGate = undefined;
    if (gate) await gate;
    return { id: `reply-${this.sent.length}` };
  }

  async sendTyping(target: Record<string, unknown>): Promise<void> {
    if (this.typingError) throw this.typingError;
    this.typing.push(target);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      void listener(...args);
    }
  }

  async emitAsync(event: string, ...args: unknown[]): Promise<void> {
    for (const listener of this.listeners.get(event) ?? []) {
      await listener(...args);
    }
  }
}

describe("QqTransport", () => {
  it("returns from start only after the SDK ready event", async () => {
    const fake = new FakeBot();
    const transport = createTransport(fake);
    let resolved = false;
    const starting = transport.start(async () => undefined).then(() => {
      resolved = true;
    });

    await fake.started.promise;
    await Promise.resolve();
    expect(resolved).toBe(false);

    fake.emit("ready");
    await starting;
    expect(resolved).toBe(true);
    expect(transport.snapshot().state).toBe("ready");
    await transport.stop();
  });

  it("maps an SDK C2C message into the gateway identity contract", async () => {
    const fake = new FakeBot();
    const transport = createTransport(fake);
    const received: IncomingMessage[] = [];
    const starting = transport.start(async (message) => {
      received.push(message);
    });
    await fake.started.promise;
    fake.emit("ready");
    await starting;

    await fake.emitAsync("message", {}, inbound({
      messageId: "message-1",
      senderId: "user-openid",
      targetId: "peer-openid",
      content: " hello ",
    }));

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      id: "message-1",
      identity: {
        transport: "qq",
        botId: "app-id",
        externalUserId: "user-openid",
        conversationId: "peer-openid",
      },
      text: "hello",
    });
    await transport.stop();
  });

  it("ignores group messages in the private-chat phase", async () => {
    const fake = new FakeBot();
    const transport = createTransport(fake);
    const received: IncomingMessage[] = [];
    const starting = transport.start(async (message) => {
      received.push(message);
    });
    await fake.started.promise;
    fake.emit("ready");
    await starting;

    await fake.emitAsync("message", {}, inbound({
      scope: "group",
      messageId: "group-message",
      senderId: "group-user",
      targetId: "group-id",
      content: "hello",
    }));

    expect(received).toHaveLength(0);
    await transport.stop();
  });

  it("attaches the inbound message ID to passive replies", async () => {
    const fake = new FakeBot();
    const transport = createTransport(fake);
    const starting = transport.start(async () => undefined);
    await fake.started.promise;
    fake.emit("ready");
    await starting;

    await fake.emitAsync("message", {}, inbound({
      messageId: "source-message",
      senderId: "user",
      targetId: "conversation",
      content: "hello",
    }));
    await transport.send({
      conversationId: "conversation",
      text: "reply",
    });

    expect(fake.sent).toEqual([{
      target: {
        scope: "c2c",
        targetId: "conversation",
        msgId: "source-message",
      },
      text: "reply",
    }]);
    await transport.stop();
  });

  it("uses the SDK-native typing indicator without allocating a separate reply sequence", async () => {
    const fake = new FakeBot();
    const transport = createTransport(fake);
    const starting = transport.start(async () => undefined);
    await fake.started.promise;
    fake.emit("ready");
    await starting;

    await fake.emitAsync("message", {}, inbound({
      messageId: "typing-source",
      senderId: "user",
      targetId: "conversation",
      content: "hello",
    }));

    await transport.setConversationActivity("conversation", "typing");

    expect(fake.typing).toEqual([{
      scope: "c2c",
      targetId: "conversation",
      msgId: "typing-source",
    }]);
    expect(transport.snapshot()).toMatchObject({
      typingSignals: 1,
      typingFailures: 0,
      activeTypingConversations: 1,
    });

    await transport.send({
      conversationId: "conversation",
      text: "finished",
    });

    expect(transport.snapshot().activeTypingConversations).toBe(0);
    expect(fake.sent[0]?.target).toEqual({
      scope: "c2c",
      targetId: "conversation",
      msgId: "typing-source",
    });
    await transport.stop();
  });

  it("treats typing delivery as best effort and preserves final text delivery", async () => {
    const fake = new FakeBot();
    fake.typingError = new Error("typing unavailable");
    const transport = createTransport(fake);
    const starting = transport.start(async () => undefined);
    await fake.started.promise;
    fake.emit("ready");
    await starting;
    await fake.emitAsync("message", {}, inbound({
      messageId: "typing-failure-source",
      senderId: "user",
      targetId: "conversation",
      content: "hello",
    }));

    await expect(
      transport.setConversationActivity("conversation", "typing"),
    ).resolves.toBeUndefined();
    expect(transport.snapshot().typingFailures).toBe(1);

    await transport.send({
      conversationId: "conversation",
      text: "still delivered",
    });
    expect(fake.sent.at(-1)?.text).toBe("still delivered");
    await transport.stop();
  });

  it("presents Markdown as readable plain text before delivery", async () => {
    const fake = new FakeBot();
    const transport = createTransport(fake);
    const starting = transport.start(async () => undefined);
    await fake.started.promise;
    fake.emit("ready");
    await starting;

    await fake.emitAsync("message", {}, inbound({
      messageId: "source-markdown",
      senderId: "user",
      targetId: "conversation",
      content: "hello",
    }));
    await transport.send({
      conversationId: "conversation",
      text: "## **标题**\n\n- 使用 `Codex`",
    });

    expect(fake.sent.map((entry) => entry.text).join("\n")).toBe(
      "标题\n\n• 使用 Codex",
    );
    await transport.stop();
  });

  it("sends long replies sequentially in bounded chunks", async () => {
    const fake = new FakeBot();
    const transport = createTransport(fake, {
      textChunkCharacters: 10,
      maxReplyChunks: 3,
    });
    const starting = transport.start(async () => undefined);
    await fake.started.promise;
    fake.emit("ready");
    await starting;
    await fake.emitAsync("message", {}, inbound({
      messageId: "source",
      senderId: "user",
      targetId: "conversation",
      content: "hello",
    }));

    await transport.send({
      conversationId: "conversation",
      text: "alpha beta gamma delta epsilon",
    });

    expect(fake.sent.length).toBeGreaterThan(1);
    expect(fake.sent.length).toBeLessThanOrEqual(3);
    expect(fake.sent.every((entry) =>
      Array.from(entry.text).length <= 10
    )).toBe(true);
    await transport.stop();
  });

  it("serializes concurrent native text sends per conversation", async () => {
    const fake = new FakeBot();
    const gate = deferred<void>();
    fake.nextSendGate = gate.promise;
    const transport = createTransport(fake);
    const starting = transport.start(async () => undefined);
    await fake.started.promise;
    fake.emit("ready");
    await starting;
    await fake.emitAsync("message", {}, inbound({
      messageId: "sequence-source",
      senderId: "user",
      targetId: "conversation",
      content: "hello",
    }));

    const first = transport.send({ conversationId: "conversation", text: "first" });
    await new Promise((resolve) => setImmediate(resolve));
    const second = transport.send({ conversationId: "conversation", text: "second" });
    await new Promise((resolve) => setImmediate(resolve));

    expect(fake.sent.map((entry) => entry.text)).toEqual(["first"]);
    expect(transport.snapshot().sequencedConversations).toBe(1);

    gate.resolve(undefined);
    await Promise.all([first, second]);
    expect(fake.sent.map((entry) => entry.text)).toEqual(["first", "second"]);
    expect(transport.snapshot().sequencedConversations).toBe(0);
    await transport.stop();
  });

  it("fails closed when a passive reply target has expired", async () => {
    let now = 1_000;
    const fake = new FakeBot();
    const transport = createTransport(fake, {
      replyTargetTtlMs: 10,
      now: () => now,
    });
    const starting = transport.start(async () => undefined);
    await fake.started.promise;
    fake.emit("ready");
    await starting;
    await fake.emitAsync("message", {}, inbound({
      messageId: "source",
      senderId: "user",
      targetId: "conversation",
      content: "hello",
    }));

    now = 1_011;
    await expect(transport.send({
      conversationId: "conversation",
      text: "late reply",
    })).rejects.toBeInstanceOf(QqReplyTargetUnavailableError);
    expect(fake.sent).toHaveLength(0);
    await transport.stop();
  });

  it("does not retry an uncertain outbound failure", async () => {
    const fake = new FakeBot();
    fake.sendError = new Error("network");
    const transport = createTransport(fake);
    const starting = transport.start(async () => undefined);
    await fake.started.promise;
    fake.emit("ready");
    await starting;
    await fake.emitAsync("message", {}, inbound({
      messageId: "source",
      senderId: "user",
      targetId: "conversation",
      content: "hello",
    }));

    await expect(transport.send({
      conversationId: "conversation",
      text: "reply",
    })).rejects.toBeInstanceOf(QqDeliveryError);
    expect(transport.snapshot().deliveryFailures).toBe(1);
    await transport.stop();
  });

  it("aborts the SDK run loop during shutdown", async () => {
    const fake = new FakeBot();
    const transport = createTransport(fake);
    const starting = transport.start(async () => undefined);
    await fake.started.promise;
    fake.emit("ready");
    await starting;

    await transport.stop();
    expect(fake.signal?.aborted).toBe(true);
    expect(transport.snapshot().state).toBe("stopped");
  });
});

function createTransport(
  fake: FakeBot,
  overrides: Partial<ConstructorParameters<typeof QqTransport>[0]> = {},
): QqTransport {
  return new QqTransport({
    appId: "app-id",
    appSecret: "app-secret",
    dataDir: ".",
    startupTimeoutMs: 1_000,
    replyTargetTtlMs: 5_000,
    replyTargetCacheEntries: 8,
    textChunkCharacters: 1_800,
    maxReplyChunks: 4,
    outboundTimeoutMs: 1_000,
    sdk: {
      accountIdStrategy: "sha256-app-id",
      sessionPersistence: "file",
      tokenPrefetch: "sync",
      logger: "redacted",
    },
    createBot: () => fake as never,
    ...overrides,
  });
}

function inbound(options: {
  messageId: string;
  senderId: string;
  targetId: string;
  content: string;
  scope?: "c2c" | "group";
}): Record<string, unknown> {
  return {
    messageId: options.messageId,
    senderId: options.senderId,
    senderName: "Test User",
    content: options.content,
    replyTarget: {
      scope: options.scope ?? "c2c",
      targetId: options.targetId,
    },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
