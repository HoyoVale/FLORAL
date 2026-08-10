import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { join } from "node:path";
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
  messagePatch?: (request: unknown) => Promise<unknown>;
  pinCreate?: (request: unknown) => Promise<unknown>;
  pinDelete?: (request: unknown) => Promise<unknown>;
  imageCreate?: (request: unknown) => Promise<unknown>;
  fileCreate?: (request: unknown) => Promise<unknown>;
  resourceGet?: (request: unknown) => Promise<{ getReadableStream(): AsyncIterable<unknown> & { destroy?: ((error?: Error) => void) | undefined } }>;
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
    inboundRoot: join(tmpdir(), "floral-feishu-inbound-test"),
    inboundMaxFileBytes: 30 * 1024 * 1024,
    inboundMaxAttachments: 8,
    inboundTimeoutMs: 1_000,
    resolveInstalledSdkVersion: async () => "1.36.0",
    createWorker: (_config: FeishuWorkerConfig) => input.worker,
    createClient: () => ({
      im: {
        messageResource: {
          get: input.resourceGet ?? (async () => ({
            getReadableStream: () => Readable.from([Buffer.from("resource")]) as AsyncIterable<unknown> & { destroy?: ((error?: Error) => void) | undefined },
          })),
        },
        v1: {
          message: {
            create: input.create ?? (async () => ({ code: 0 })),
            patch: input.messagePatch ?? (async () => ({ code: 0 })),
          },
          pin: {
            create: input.pinCreate ?? (async () => ({ code: 0 })),
            delete: input.pinDelete ?? (async () => ({ code: 0 })),
          },
          image: {
            create: input.imageCreate ?? (async () => ({
              image_key: "img_test",
            })),
          },
          file: {
            create: input.fileCreate ?? (async () => ({
              file_key: "file_test",
            })),
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

  it("dispatches Feishu worker attachment refs into the inbound contract", async () => {
    const worker = new FakeWorker();
    const received: unknown[] = [];
    const transport = new FeishuTransport(options({ worker }));
    await startTransport(transport, worker, async (message) => {
      received.push(message);
    });

    worker.message({
      type: "message",
      message: {
        id: "om_image",
        botId: "cli_floral",
        externalUserId: "ou_owner",
        conversationId: "oc_chat",
        text: "",
        attachments: [{
          id: "image:img_owner",
          kind: "image",
          resourceKey: "img_owner",
        }],
        receivedAtMs: 1_786_123_456_789,
      },
    });
    await Promise.resolve();

    expect(received).toEqual([{
      id: "om_image",
      identity: {
        transport: "feishu",
        botId: "cli_floral",
        externalUserId: "ou_owner",
        conversationId: "oc_chat",
      },
      text: "",
      attachments: [{
        id: "image:img_owner",
        kind: "image",
        source: {
          transport: "feishu",
          messageId: "om_image",
          resourceKey: "img_owner",
        },
      }],
      receivedAt: new Date(1_786_123_456_789),
    }]);
    await transport.stop();
  });

  it("materializes authenticated Feishu resource references", async () => {
    const worker = new FakeWorker();
    const root = await mkdtemp(join(tmpdir(), "floral-feishu-inbound-"));
    const requests: unknown[] = [];
    const transport = new FeishuTransport({
      ...options({
        worker,
        resourceGet: async (request) => {
          requests.push(request);
          const type = (request as { params?: { type?: unknown } }).params?.type;
          const bytes = type === "image"
            ? Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])
            : Buffer.from("hello file");
          return { getReadableStream: () => Readable.from([bytes]) as AsyncIterable<unknown> & { destroy?: ((error?: Error) => void) | undefined } };
        },
      }),
      inboundRoot: root,
    });
    try {
      await startTransport(transport, worker);
      const result = await transport.materializeInboundAttachments({
        id: "om_media",
        identity: { transport: "feishu", botId: "cli_floral", externalUserId: "ou_owner", conversationId: "oc_chat" },
        text: "inspect",
        attachments: [
          { id: "image:img_1", kind: "image", source: { transport: "feishu", messageId: "om_media", resourceKey: "img_1" } },
          { id: "file:file_1", kind: "file", fileName: "../../report.pdf", source: { transport: "feishu", messageId: "om_media", resourceKey: "file_1" } },
        ],
        receivedAt: new Date(),
      });
      expect(requests).toEqual([
        { params: { type: "image" }, path: { message_id: "om_media", file_key: "img_1" } },
        { params: { type: "file" }, path: { message_id: "om_media", file_key: "file_1" } },
      ]);
      expect(result.attachments?.[0]?.localPath).toMatch(/image-01\.png$/u);
      expect(result.attachments?.[1]?.localPath).toMatch(/file-02\.pdf$/u);
    } finally {
      await transport.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("materializes project attachments under the project data namespace", async () => {
    const worker = new FakeWorker();
    const root = await mkdtemp(join(tmpdir(), "floral-feishu-project-inbound-"));
    const projectRoot = join(root, "projects");
    const namespace = "0123456789abcdef01234567";
    const transport = new FeishuTransport({
      ...options({
        worker,
        resourceGet: async () => ({
          getReadableStream: () =>
            Readable.from([Buffer.from("project file")]) as AsyncIterable<unknown> & {
              destroy?: ((error?: Error) => void) | undefined;
            },
        }),
      }),
      inboundRoot: join(root, "global"),
      projectInboundRoot: projectRoot,
    });
    try {
      await startTransport(transport, worker);
      const result = await transport.materializeInboundAttachments({
        id: "om_project_media",
        identity: {
          transport: "feishu",
          botId: "cli_floral",
          externalUserId: "ou_owner",
          conversationId: "oc_chat",
        },
        text: "",
        attachments: [{
          id: "file:file_project",
          kind: "file",
          fileName: "notes.txt",
          source: {
            transport: "feishu",
            messageId: "om_project_media",
            resourceKey: "file_project",
          },
        }],
        receivedAt: new Date(),
      }, { projectNamespace: namespace });

      expect(result.attachments?.[0]?.localPath).toContain(
        join("projects", namespace, "inbound", "feishu"),
      );
    } finally {
      await transport.stop();
      await rm(root, { recursive: true, force: true });
    }
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

  it("derives stable per-chunk Feishu UUIDs for idempotent delivery", async () => {
    const worker = new FakeWorker();
    const requests: Array<{ data?: { uuid?: string } }> = [];
    const transport = new FeishuTransport(options({
      worker,
      create: async (request) => {
        requests.push(request as { data?: { uuid?: string } });
        return { code: 0 };
      },
    }));
    await startTransport(transport, worker);

    await transport.sendIdempotent(
      { conversationId: "oc_chat", text: "one two three four five six seven eight" },
      "delivery:stable-key",
    );
    const firstAttempt = requests.map((request) => request.data?.uuid);
    requests.length = 0;
    await transport.sendIdempotent(
      { conversationId: "oc_chat", text: "one two three four five six seven eight" },
      "delivery:stable-key",
    );

    expect(firstAttempt.length).toBeGreaterThan(1);
    expect(firstAttempt.every((uuid) => /^[a-f0-9]{32}$/u.test(uuid ?? ""))).toBe(true);
    expect(new Set(firstAttempt).size).toBe(firstAttempt.length);
    expect(requests.map((request) => request.data?.uuid)).toEqual(firstAttempt);
    await transport.stop();
  });

  it("renders Markdown through post/md while ordinary text stays text", async () => {
    const worker = new FakeWorker();
    const requests: unknown[] = [];
    const transport = new FeishuTransport(options({
      worker,
      create: async (request) => {
        requests.push(request);
        return { code: 0 };
      },
    }));
    await startTransport(transport, worker);

    await transport.send({
      conversationId: "oc_chat",
      text: "**Status**\n\n| Item | Value |\n|---|---|\n| ok | yes |",
    });
    await transport.send({
      conversationId: "oc_chat",
      text: "plain hello",
    });

    const rich = requests[0] as { data?: { msg_type?: unknown; content?: string } };
    const plain = requests[1] as { data?: { msg_type?: unknown } };
    expect(rich.data?.msg_type).toBe("post");
    const richContent = JSON.parse(rich.data?.content ?? "{}") as {
      zh_cn?: { content?: Array<Array<{ tag?: unknown; text?: unknown }>> };
    };
    expect(richContent.zh_cn?.content?.[0]?.[0]?.tag).toBe("md");
    expect(richContent.zh_cn?.content?.[0]?.[0]?.text).toContain("| Item | Value |");
    expect(plain.data?.msg_type).toBe("text");

    await transport.stop();
  });

  it("uploads and sends native image/file messages", async () => {
    const worker = new FakeWorker();
    const messageRequests: unknown[] = [];
    const imageUploads: unknown[] = [];
    const fileUploads: unknown[] = [];
    const dir = await mkdtemp(join(tmpdir(), "floral-feishu-transport-media-"));
    const imagePath = join(dir, "screen.png");
    const filePath = join(dir, "report.txt");
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(filePath, "report");

    try {
      const transport = new FeishuTransport(options({
        worker,
        create: async (request) => {
          messageRequests.push(request);
          return { code: 0 };
        },
        imageCreate: async (request) => {
          imageUploads.push(request);
          return { image_key: "img_native" };
        },
        fileCreate: async (request) => {
          fileUploads.push(request);
          return { file_key: "file_native" };
        },
      }));
      await startTransport(transport, worker);

      await transport.sendMedia({
        conversationId: "oc_chat",
        kind: "image",
        localPath: imagePath,
      });
      await transport.sendMedia({
        conversationId: "oc_chat",
        kind: "file",
        localPath: filePath,
        caption: "**report ready**",
      });

      expect(imageUploads).toHaveLength(1);
      expect(fileUploads).toHaveLength(1);

      const imageMessage = messageRequests[0] as {
        data?: { msg_type?: unknown; content?: string };
      };
      const fileMessage = messageRequests[1] as {
        data?: { msg_type?: unknown; content?: string };
      };
      const captionMessage = messageRequests[2] as {
        data?: { msg_type?: unknown };
      };
      expect(imageMessage.data?.msg_type).toBe("image");
      expect(JSON.parse(imageMessage.data?.content ?? "{}")).toEqual({
        image_key: "img_native",
      });
      expect(fileMessage.data?.msg_type).toBe("file");
      expect(JSON.parse(fileMessage.data?.content ?? "{}")).toEqual({
        file_key: "file_native",
      });
      expect(captionMessage.data?.msg_type).toBe("post");

      await transport.stop();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("accepts a nested upload envelope from an injected client as a defensive fallback", async () => {
    const worker = new FakeWorker();
    const messageRequests: unknown[] = [];
    const dir = await mkdtemp(join(tmpdir(), "floral-feishu-nested-media-"));
    const imagePath = join(dir, "screen.png");
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    try {
      const transport = new FeishuTransport(options({
        worker,
        create: async (request) => {
          messageRequests.push(request);
          return { code: 0 };
        },
        imageCreate: async () => ({
          code: 0,
          data: { image_key: "img_nested" },
        }),
      }));
      await startTransport(transport, worker);

      await transport.sendMedia({
        conversationId: "oc_chat",
        kind: "image",
        localPath: imagePath,
      });

      const imageMessage = messageRequests[0] as {
        data?: { msg_type?: unknown; content?: string };
      };
      expect(imageMessage.data?.msg_type).toBe("image");
      expect(JSON.parse(imageMessage.data?.content ?? "{}")).toEqual({
        image_key: "img_nested",
      });

      await transport.stop();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
