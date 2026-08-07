import { Worker } from "node:worker_threads";
import * as Lark from "@larksuiteoapi/node-sdk";
import type {
  ChatTransport,
  InteractiveApprovalPrompt,
  InteractiveApprovalTransport,
  MediaTransport,
} from "../../core/contracts.js";
import type {
  IncomingMessage,
  OutgoingMediaMessage,
  OutgoingMessage,
} from "../../core/types.js";
import { buildFeishuApprovalCard } from "./feishu-card.js";
import { loadFeishuLocalMedia } from "./feishu-media.js";
import {
  hasFeishuRenderableMarkdown,
  serializeFeishuMarkdownPostIfSafe,
} from "./feishu-rich-text.js";
import { assertInstalledFeishuSdkVersion } from "./feishu-sdk-contract.js";
import type {
  FeishuWorkerConfig,
  FeishuWorkerMessage,
} from "./feishu-worker-protocol.js";

const DEFAULT_TRUNCATION_SUFFIX = "\n\n[回复过长，后续内容已截断]";

export interface FeishuTransportOptions {
  appId: string;
  appSecret: string;
  expectedSdkVersion: string;
  startupTimeoutMs: number;
  outboundTimeoutMs: number;
  textChunkBytes: number;
  maxReplyChunks: number;
  createClient?: (() => FeishuOutboundClient) | undefined;
  createWorker?: ((config: FeishuWorkerConfig) => FeishuWorkerLike) | undefined;
  resolveInstalledSdkVersion?: ((expectedVersion: string) => Promise<string>) | undefined;
  onFatal?: ((error: Error) => void) | undefined;
}

interface FeishuOutboundClient {
  im: {
    v1: {
      message: {
        create(input: {
          params: { receive_id_type: "chat_id" };
          data: {
            receive_id: string;
            msg_type: "text" | "post" | "image" | "file" | "interactive";
            content: string;
          };
        }): Promise<unknown>;
      };
      image: {
        create(input: {
          data: {
            image_type: "message";
            image: Buffer;
          };
        }): Promise<unknown>;
      };
      file: {
        create(input: {
          data: {
            file_type: "stream";
            file_name: string;
            file: Buffer;
          };
        }): Promise<unknown>;
      };
    };
  };
}

export interface FeishuWorkerLike {
  on(event: "message", listener: (message: FeishuWorkerMessage) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (code: number) => void): this;
  terminate(): Promise<number>;
}

interface FeishuApprovalInteractionRoute {
  conversationId: string;
  expectedExternalUserId: string;
  timer: ReturnType<typeof setTimeout>;
}

const MAX_FEISHU_CONVERSATION_USERS = 512;

export class FeishuTransport
  implements ChatTransport, InteractiveApprovalTransport, MediaTransport
{
  readonly name = "feishu";
  readonly #client: FeishuOutboundClient;
  readonly #outboundTails = new Map<string, Promise<void>>();
  readonly #conversationUsers = new Map<string, string>();
  readonly #approvalInteractionRoutes = new Map<string, FeishuApprovalInteractionRoute>();
  #worker: FeishuWorkerLike | undefined;
  #onMessage: ((message: IncomingMessage) => Promise<void>) | undefined;
  #started = false;
  #stopped = false;
  #fatalReported = false;

  constructor(private readonly options: FeishuTransportOptions) {
    validateOptions(options);
    this.#client = options.createClient?.() ?? new Lark.Client({
      appId: options.appId,
      appSecret: options.appSecret,
      loggerLevel: Lark.LoggerLevel.info,
    }) as unknown as FeishuOutboundClient;
  }

  async start(onMessage: (message: IncomingMessage) => Promise<void>): Promise<void> {
    if (this.#started) return;
    if (this.#stopped) throw new Error("Feishu transport cannot restart after stop");

    await (this.options.resolveInstalledSdkVersion?.(this.options.expectedSdkVersion)
      ?? assertInstalledFeishuSdkVersion(this.options.expectedSdkVersion));

    const worker = this.options.createWorker?.({
      appId: this.options.appId,
      appSecret: this.options.appSecret,
    }) ?? createDefaultWorker({
      appId: this.options.appId,
      appSecret: this.options.appSecret,
    });

    this.#worker = worker;
    this.#onMessage = onMessage;

    const startup = deferred<void>();
    let startupSettled = false;
    const settleStartup = (error?: unknown) => {
      if (startupSettled) return;
      startupSettled = true;
      if (error) startup.reject(error);
      else startup.resolve(undefined);
    };

    worker.on("message", (message) => {
      if (message.type === "started") {
        settleStartup();
        return;
      }
      if (message.type === "fatal") {
        const error = new Error(`Feishu WS worker failed: ${message.errorType}`);
        settleStartup(error);
        if (this.#started) this.#reportFatal(error);
        return;
      }
      if (message.type === "message") {
        this.#dispatchInbound(message);
        return;
      }
      if (message.type === "card-action") {
        this.#dispatchApprovalAction(message);
      }
    });
    worker.on("error", (error) => {
      settleStartup(error);
      if (this.#started) this.#reportFatal(error);
    });
    worker.on("exit", (code) => {
      if (this.#stopped) return;
      const error = new Error(
        `Feishu WS worker exited unexpectedly with code ${String(code)}`,
      );
      settleStartup(error);
      if (this.#started) this.#reportFatal(error);
    });

    try {
      await withTimeout(
        startup.promise,
        this.options.startupTimeoutMs,
        "Feishu transport startup",
      );
      this.#started = true;
      process.stderr.write("feishu.transport.worker=started\n");
    } catch (error) {
      this.#worker = undefined;
      this.#onMessage = undefined;
      await worker.terminate().catch(() => undefined);
      throw error;
    }
  }

  async send(message: OutgoingMessage): Promise<void> {
    if (!this.#started || this.#stopped) {
      throw new Error("Feishu transport is not ready");
    }
    if (!message.conversationId.trim()) {
      throw new Error("Feishu conversation id must not be empty");
    }

    const conversationId = message.conversationId;
    const previous = this.#outboundTails.get(conversationId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.#sendNow(message));
    this.#outboundTails.set(conversationId, current);
    try {
      await current;
    } finally {
      if (this.#outboundTails.get(conversationId) === current) {
        this.#outboundTails.delete(conversationId);
      }
    }
  }

  async sendMedia(message: OutgoingMediaMessage): Promise<void> {
    if (!this.#started || this.#stopped) {
      throw new Error("Feishu transport is not ready");
    }
    const conversationId = message.conversationId.trim();
    if (!conversationId) {
      throw new Error("Feishu media conversation id must not be empty");
    }

    const previous = this.#outboundTails.get(conversationId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.#sendMediaNow({ ...message, conversationId }));
    this.#outboundTails.set(conversationId, current);
    try {
      await current;
    } finally {
      if (this.#outboundTails.get(conversationId) === current) {
        this.#outboundTails.delete(conversationId);
      }
    }
  }

  async sendInteractiveApprovalPrompt(
    prompt: InteractiveApprovalPrompt,
  ): Promise<void> {
    if (!this.#started || this.#stopped) {
      throw new Error("Feishu transport is not ready");
    }

    const conversationId = prompt.conversationId.trim();
    if (!conversationId) {
      throw new Error("Feishu approval conversation id must not be empty");
    }
    const expectedExternalUserId = this.#conversationUsers.get(conversationId);
    if (!expectedExternalUserId) {
      throw new Error("Feishu approval route is unavailable for this conversation");
    }

    const approvalId = prompt.approvalId.trim().toUpperCase();
    const card = buildFeishuApprovalCard({
      ...prompt,
      conversationId,
      approvalId,
    });

    const previous = this.#outboundTails.get(conversationId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        await this.#sendMessagePayload(
          conversationId,
          "interactive",
          JSON.stringify(card),
          "Feishu interactive approval",
        );
      });
    this.#outboundTails.set(conversationId, current);
    try {
      await current;
    } finally {
      if (this.#outboundTails.get(conversationId) === current) {
        this.#outboundTails.delete(conversationId);
      }
    }

    this.#rememberApprovalInteractionRoute(
      approvalId,
      conversationId,
      expectedExternalUserId,
      prompt.ttlMs,
    );
    process.stderr.write("feishu.transport.approval_card=sent scope=p2p\n");
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#started = false;
    this.#onMessage = undefined;
    const worker = this.#worker;
    this.#worker = undefined;
    this.#outboundTails.clear();
    this.#conversationUsers.clear();
    this.#clearApprovalInteractionRoutes();
    if (worker) await worker.terminate().catch(() => undefined);
  }

  async #sendNow(message: OutgoingMessage): Promise<void> {
    const normalized = normalizeFeishuOutgoingText(message.text);
    if (hasFeishuRenderableMarkdown(normalized)) {
      const post = serializeFeishuMarkdownPostIfSafe(normalized);
      if (post) {
        await this.#sendMessagePayload(
          message.conversationId,
          "post",
          post,
          "Feishu rich-text message",
        );
        return;
      }
      process.stderr.write("feishu.transport.rich_text_fallback=oversize\n");
    }

    const chunks = splitFeishuText(
      normalized,
      this.options.textChunkBytes,
      this.options.maxReplyChunks,
    );
    for (const chunk of chunks) {
      await this.#sendMessagePayload(
        message.conversationId,
        "text",
        JSON.stringify({ text: chunk }),
        "Feishu outbound message",
      );
    }
  }

  async #sendMediaNow(message: OutgoingMediaMessage): Promise<void> {
    const media = await loadFeishuLocalMedia(message);

    if (media.kind === "image") {
      const upload = await withTimeout(
        this.#client.im.v1.image.create({
          data: { image_type: "message", image: media.bytes },
        }),
        this.options.outboundTimeoutMs,
        "Feishu image upload",
      );
      const imageKey = requireFeishuResponseKey(upload, "image_key");
      await this.#sendMessagePayload(
        message.conversationId,
        "image",
        JSON.stringify({ image_key: imageKey }),
        "Feishu image message",
      );
    } else {
      const upload = await withTimeout(
        this.#client.im.v1.file.create({
          data: {
            file_type: "stream",
            file_name: media.fileName,
            file: media.bytes,
          },
        }),
        this.options.outboundTimeoutMs,
        "Feishu file upload",
      );
      const fileKey = requireFeishuResponseKey(upload, "file_key");
      await this.#sendMessagePayload(
        message.conversationId,
        "file",
        JSON.stringify({ file_key: fileKey }),
        "Feishu file message",
      );
    }

    if (message.caption?.trim()) {
      await this.#sendNow({
        conversationId: message.conversationId,
        text: message.caption,
      });
    }

    process.stderr.write(
      `feishu.transport.media=sent kind=${media.kind} bytes=${String(media.byteLength)}\n`,
    );
  }

  async #sendMessagePayload(
    conversationId: string,
    msgType: "text" | "post" | "image" | "file" | "interactive",
    content: string,
    label: string,
  ): Promise<void> {
    const response = await withTimeout(
      this.#client.im.v1.message.create({
        params: { receive_id_type: "chat_id" },
        data: { receive_id: conversationId, msg_type: msgType, content },
      }),
      this.options.outboundTimeoutMs,
      label,
    );
    assertFeishuApiSuccess(response);
  }

  #dispatchInbound(message: Extract<FeishuWorkerMessage, { type: "message" }>): void {
    const onMessage = this.#onMessage;
    if (!onMessage || this.#stopped) return;
    const value = message.message;
    const receivedAt = new Date(value.receivedAtMs);
    if (!Number.isFinite(receivedAt.getTime())) return;

    this.#rememberConversationUser(
      value.conversationId,
      value.externalUserId,
    );

    // Return to the Feishu worker immediately. Gateway/Codex processing happens in
    // the parent and message_id remains the durable SQLite deduplication key.
    void onMessage({
      id: value.id,
      identity: {
        transport: "feishu",
        botId: value.botId,
        externalUserId: value.externalUserId,
        conversationId: value.conversationId,
      },
      text: value.text,
      receivedAt,
    }).catch((error) => {
      process.stderr.write(
        `feishu.transport.inbound_handler_error=${errorName(error)}\n`,
      );
    });
  }

  #dispatchApprovalAction(
    message: Extract<FeishuWorkerMessage, { type: "card-action" }>,
  ): void {
    const onMessage = this.#onMessage;
    if (!onMessage || this.#stopped) return;

    const value = message.action;
    const approvalId = value.approvalId.trim().toUpperCase();
    const route = this.#approvalInteractionRoutes.get(approvalId);
    if (!route) {
      process.stderr.write("feishu.transport.card_action_ignored=unknown-approval\n");
      return;
    }
    if (
      route.conversationId !== value.conversationId
      || route.expectedExternalUserId !== value.externalUserId
    ) {
      process.stderr.write("feishu.transport.card_action_ignored=scope-mismatch\n");
      return;
    }

    const receivedAt = new Date(value.receivedAtMs);
    if (!Number.isFinite(receivedAt.getTime())) {
      process.stderr.write("feishu.transport.card_action_ignored=invalid-time\n");
      return;
    }

    process.stderr.write(
      `feishu.transport.approval_card_action=received decision=${value.decision}\n`,
    );
    void onMessage({
      id: `feishu-card-action:${value.eventId}`,
      identity: {
        transport: "feishu",
        botId: this.options.appId,
        externalUserId: value.externalUserId,
        conversationId: value.conversationId,
      },
      text: `/${value.decision} ${approvalId}`,
      receivedAt,
    }).catch((error) => {
      process.stderr.write(
        `feishu.transport.card_action_handler_error=${errorName(error)}\n`,
      );
    });
  }

  #rememberConversationUser(conversationId: string, externalUserId: string): void {
    this.#conversationUsers.delete(conversationId);
    this.#conversationUsers.set(conversationId, externalUserId);
    while (this.#conversationUsers.size > MAX_FEISHU_CONVERSATION_USERS) {
      const oldest = this.#conversationUsers.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#conversationUsers.delete(oldest);
    }
  }

  #rememberApprovalInteractionRoute(
    approvalId: string,
    conversationId: string,
    expectedExternalUserId: string,
    ttlMs: number,
  ): void {
    const existing = this.#approvalInteractionRoutes.get(approvalId);
    if (existing) clearTimeout(existing.timer);

    const timer = setTimeout(() => {
      const current = this.#approvalInteractionRoutes.get(approvalId);
      if (current?.timer === timer) {
        this.#approvalInteractionRoutes.delete(approvalId);
      }
    }, ttlMs);
    timer.unref?.();

    this.#approvalInteractionRoutes.set(approvalId, {
      conversationId,
      expectedExternalUserId,
      timer,
    });
  }

  #clearApprovalInteractionRoutes(): void {
    for (const route of this.#approvalInteractionRoutes.values()) {
      clearTimeout(route.timer);
    }
    this.#approvalInteractionRoutes.clear();
  }

  #reportFatal(error: Error): void {
    if (this.#fatalReported || this.#stopped) return;
    this.#fatalReported = true;
    process.stderr.write(`feishu.transport.fatal=${errorName(error)}\n`);
    this.options.onFatal?.(error);
  }
}

export function splitFeishuText(
  text: string,
  maxBytes: number,
  maxChunks: number,
  truncationSuffix = DEFAULT_TRUNCATION_SUFFIX,
): string[] {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("Feishu text chunk size must be a positive integer");
  }
  if (!Number.isInteger(maxChunks) || maxChunks <= 0) {
    throw new Error("Feishu maximum reply chunks must be a positive integer");
  }

  const normalized = text.replace(/\r\n?/gu, "\n").trim();
  if (!normalized) return ["（空回复）"];
  if (Buffer.byteLength(normalized, "utf8") <= maxBytes) return [normalized];

  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  const characters = Array.from(normalized);

  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index] ?? "";
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (characterBytes > maxBytes) {
      throw new Error("Feishu text chunk size is too small for a Unicode code point");
    }

    if (current && currentBytes + characterBytes > maxBytes) {
      if (chunks.length + 1 >= maxChunks) {
        chunks.push(withUtf8Suffix(current, truncationSuffix, maxBytes));
        return chunks;
      }
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += character;
    currentBytes += characterBytes;
  }

  if (current) chunks.push(current);
  return chunks;
}

function withUtf8Suffix(body: string, suffix: string, maxBytes: number): string {
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  if (suffixBytes >= maxBytes) {
    return takeUtf8Prefix(suffix, maxBytes);
  }
  return `${takeUtf8Prefix(body, maxBytes - suffixBytes)}${suffix}`;
}

function takeUtf8Prefix(value: string, maxBytes: number): string {
  let output = "";
  let bytes = 0;
  for (const character of value) {
    const next = Buffer.byteLength(character, "utf8");
    if (bytes + next > maxBytes) break;
    output += character;
    bytes += next;
  }
  return output;
}

function createDefaultWorker(config: FeishuWorkerConfig): FeishuWorkerLike {
  const workerUrl = new URL(
    import.meta.url.endsWith(".ts")
      ? "./feishu-ws-worker.ts"
      : "./feishu-ws-worker.js",
    import.meta.url,
  );
  return new Worker(workerUrl, {
    workerData: config,
  }) as unknown as FeishuWorkerLike;
}

function validateOptions(options: FeishuTransportOptions): void {
  if (!options.appId.trim() || !options.appSecret.trim()) {
    throw new Error("Feishu transport credentials must not be empty");
  }
  if (!options.expectedSdkVersion.trim()) {
    throw new Error("Feishu transport expected SDK version must not be empty");
  }
  for (const [label, value] of [
    ["startupTimeoutMs", options.startupTimeoutMs],
    ["outboundTimeoutMs", options.outboundTimeoutMs],
    ["textChunkBytes", options.textChunkBytes],
    ["maxReplyChunks", options.maxReplyChunks],
  ] as const) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`Feishu transport ${label} must be a positive integer`);
    }
  }
  if (options.startupTimeoutMs > 120_000 || options.outboundTimeoutMs > 120_000) {
    throw new Error("Feishu transport timeout exceeds 120000ms");
  }
  if (options.textChunkBytes > 140_000) {
    throw new Error("Feishu text chunk size exceeds 140000 bytes");
  }
  if (options.maxReplyChunks > 5) {
    throw new Error("Feishu maximum reply chunks exceeds 5");
  }
}

function assertFeishuApiSuccess(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  const code = (value as { code?: unknown }).code;
  if (typeof code === "number" && code !== 0) {
    throw new Error(`Feishu API returned non-zero code ${String(code)}`);
  }
}

function requireFeishuResponseKey(
  value: unknown,
  key: "image_key" | "file_key",
): string {
  assertFeishuApiSuccess(value);
  if (typeof value !== "object" || value === null) {
    throw new Error(`Feishu upload response missing ${key}`);
  }

  // @larksuiteoapi/node-sdk's generated semantic client strips the outer
  // HTTP envelope and returns `response.data` directly for upload APIs.
  // Therefore image_key/file_key are normally top-level fields. Keep the
  // nested form as a defensive fallback for injected/custom clients.
  const record = value as Record<string, unknown>;
  const direct = record[key];
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }

  const data = record.data;
  if (typeof data === "object" && data !== null) {
    const nested = (data as Record<string, unknown>)[key];
    if (typeof nested === "string" && nested.trim()) {
      return nested.trim();
    }
  }

  throw new Error(`Feishu upload response missing ${key}`);
}

function normalizeFeishuOutgoingText(value: string): string {
  const normalized = value.replace(/\r\n?/gu, "\n").trim();
  return normalized || "（空回复）";
}

function errorName(error: unknown): string {
  return error instanceof Error && error.name.trim() ? error.name : "Error";
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${String(timeoutMs)}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
