import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import * as Lark from "@larksuiteoapi/node-sdk";
import type {
  AgentStatusSnapshot,
  ChatTransport,
  IdempotentTextTransport,
  InboundAttachmentMaterializer,
  InteractiveApprovalPrompt,
  InteractiveApprovalTransport,
  MediaTransport,
  StatusCardTransport,
} from "../../core/contracts.js";
import type {
  IncomingAttachment,
  IncomingMessage,
  OutgoingMediaMessage,
  OutgoingMessage,
} from "../../core/types.js";
import { buildFeishuApprovalCard } from "./feishu-card.js";
import {
  buildAgentStatusCard,
  normalizeFeishuStatusControlCardAction,
  STATUS_CONTROL_MESSAGE_PREFIX,
} from "./feishu-status-card.js";
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
  inboundRoot: string;
  projectInboundRoot?: string | undefined;
  inboundMaxFileBytes: number;
  inboundMaxAttachments: number;
  inboundTimeoutMs: number;
  createClient?: (() => FeishuOutboundClient) | undefined;
  createWorker?: ((config: FeishuWorkerConfig) => FeishuWorkerLike) | undefined;
  resolveInstalledSdkVersion?: ((expectedVersion: string) => Promise<string>) | undefined;
  onFatal?: ((error: Error) => void) | undefined;
}

interface FeishuBinaryDownload {
  getReadableStream(): AsyncIterable<unknown> & {
    destroy?: ((error?: Error) => void) | undefined;
  };
}

interface FeishuOutboundClient {
  im: {
    messageResource: {
      get(input: {
        params: { type: "image" | "file" };
        path: { message_id: string; file_key: string };
      }): Promise<FeishuBinaryDownload>;
    };
    v1: {
      message: {
        create(input: {
          params: { receive_id_type: "chat_id" };
          data: {
            receive_id: string;
            msg_type: "text" | "post" | "image" | "file" | "interactive";
            content: string;
            uuid?: string | undefined;
          };
        }): Promise<unknown>;
        patch(input: {
          data: { content: string };
          path: { message_id: string };
        }): Promise<unknown>;
      };
      pin: {
        create(input: {
          data: { message_id: string };
        }): Promise<unknown>;
        delete(input: {
          path: { message_id: string };
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
  implements
    ChatTransport,
    IdempotentTextTransport,
    InboundAttachmentMaterializer,
    InteractiveApprovalTransport,
    MediaTransport,
    StatusCardTransport
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
        return;
      }
      if (message.type === "status-control") {
        this.#dispatchStatusControl(message);
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

  async materializeInboundAttachments(
    message: IncomingMessage,
    options: { projectNamespace?: string | undefined } = {},
  ): Promise<IncomingMessage> {
    const attachments = message.attachments ?? [];
    if (attachments.length === 0) return message;
    if (attachments.length > this.options.inboundMaxAttachments) {
      throw new Error(`Feishu inbound attachment count exceeds ${String(this.options.inboundMaxAttachments)}`);
    }
    if (attachments.some((item) => item.source.transport !== "feishu" || item.source.messageId !== message.id)) {
      throw new Error("Feishu inbound attachment source does not match the message");
    }

    const projectNamespace = options.projectNamespace?.trim();
    if (projectNamespace && !/^[a-f0-9]{24}$/u.test(projectNamespace)) {
      throw new Error("Invalid FLORAL project attachment namespace");
    }
    const root = projectNamespace
      ? resolve(
          this.options.projectInboundRoot
            ?? join(resolve(this.options.inboundRoot), "..", "..", "projects"),
          projectNamespace,
          "inbound",
          "feishu",
        )
      : resolve(this.options.inboundRoot);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const fingerprint = createHash("sha256").update(message.id).digest("hex").slice(0, 20);
    const directory = await mkdtemp(join(root, `${fingerprint}-`));
    try {
      const materialized: IncomingAttachment[] = [];
      for (let index = 0; index < attachments.length; index += 1) {
        materialized.push(await this.#downloadInboundAttachment(directory, attachments[index]!, index));
      }
      const totalBytes = materialized.reduce((sum, item) => sum + (item.byteLength ?? 0), 0);
      process.stderr.write(`feishu.transport.inbound_media=materialized count=${String(materialized.length)} bytes=${String(totalBytes)}\n`);
      return { ...message, attachments: materialized };
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async send(message: OutgoingMessage): Promise<void> {
    await this.#enqueueText(message);
  }

  async sendIdempotent(
    message: OutgoingMessage,
    idempotencyKey: string,
  ): Promise<void> {
    const normalizedKey = idempotencyKey.trim();
    if (!normalizedKey || Buffer.byteLength(normalizedKey, "utf8") > 240) {
      throw new Error("Feishu idempotency key must be between 1 and 240 bytes");
    }
    await this.#enqueueText(message, normalizedKey);
  }

  async #enqueueText(
    message: OutgoingMessage,
    idempotencyKey?: string,
  ): Promise<void> {
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
      .then(() => this.#sendNow(message, idempotencyKey));
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

  async sendStatusCard(
    conversationId: string,
    snapshot: AgentStatusSnapshot,
  ): Promise<{ messageId: string }> {
    if (!this.#started || this.#stopped) {
      throw new Error("Feishu transport is not ready");
    }
    const card = buildAgentStatusCard(snapshot);
    const messageId = await this.#sendMessagePayload(
      conversationId,
      "interactive",
      JSON.stringify(card),
      "Feishu agent status card",
    );
    if (!messageId) {
      throw new Error("Feishu status card send returned no message_id");
    }
    return { messageId };
  }

  async updateStatusCard(
    messageId: string,
    snapshot: AgentStatusSnapshot,
  ): Promise<void> {
    if (!this.#started || this.#stopped) {
      throw new Error("Feishu transport is not ready");
    }
    const card = buildAgentStatusCard(snapshot);
    const response = await withTimeout(
      this.#client.im.v1.message.patch({
        data: { content: JSON.stringify(card) },
        path: { message_id: messageId },
      }),
      this.options.outboundTimeoutMs,
      "Feishu status card update",
    );
    assertFeishuApiSuccess(response);
  }

  async pinStatusCard(messageId: string): Promise<void> {
    if (!this.#started || this.#stopped) {
      throw new Error("Feishu transport is not ready");
    }
    const response = await withTimeout(
      this.#client.im.v1.pin.create({ data: { message_id: messageId } }),
      this.options.outboundTimeoutMs,
      "Feishu status card pin",
    );
    assertFeishuApiSuccess(response);
  }

  async unpinStatusCard(messageId: string): Promise<void> {
    if (!this.#started || this.#stopped) {
      throw new Error("Feishu transport is not ready");
    }
    const response = await withTimeout(
      this.#client.im.v1.pin.delete({ path: { message_id: messageId } }),
      this.options.outboundTimeoutMs,
      "Feishu status card unpin",
    );
    assertFeishuApiSuccess(response);
  }

  async #sendNow(
    message: OutgoingMessage,
    idempotencyKey?: string,
  ): Promise<void> {
    const normalized = normalizeFeishuOutgoingText(message.text);
    if (hasFeishuRenderableMarkdown(normalized)) {
      const post = serializeFeishuMarkdownPostIfSafe(normalized);
      if (post) {
        await this.#sendMessagePayload(
          message.conversationId,
          "post",
          post,
          "Feishu rich-text message",
          idempotencyKey ? feishuDeliveryUuid(idempotencyKey, 0) : undefined,
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
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index]!;
      await this.#sendMessagePayload(
        message.conversationId,
        "text",
        JSON.stringify({ text: chunk }),
        "Feishu outbound message",
        idempotencyKey ? feishuDeliveryUuid(idempotencyKey, index) : undefined,
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
    uuid?: string,
  ): Promise<string | undefined> {
    const response = await withTimeout(
      this.#client.im.v1.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: conversationId,
          msg_type: msgType,
          content,
          ...(uuid ? { uuid } : {}),
        },
      }),
      this.options.outboundTimeoutMs,
      label,
    );
    assertFeishuApiSuccess(response);
    return readFeishuResponseMessageId(response);
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
      ...(value.attachments?.length ? {
        attachments: value.attachments.map((attachment) => ({
          id: attachment.id,
          kind: attachment.kind,
          ...(attachment.fileName ? { fileName: attachment.fileName } : {}),
          source: {
            transport: "feishu" as const,
            messageId: value.id,
            resourceKey: attachment.resourceKey,
          },
        })),
      } : {}),
      receivedAt,
    }).catch((error) => {
      process.stderr.write(
        `feishu.transport.inbound_handler_error=${errorName(error)}\n`,
      );
    });
  }

  async #downloadInboundAttachment(
    directory: string,
    attachment: IncomingAttachment,
    index: number,
  ): Promise<IncomingAttachment> {
    const response = await withTimeout(
      this.#client.im.messageResource.get({
        params: { type: attachment.kind },
        path: {
          message_id: attachment.source.messageId,
          file_key: attachment.source.resourceKey,
        },
      }),
      this.options.inboundTimeoutMs,
      "Feishu inbound resource response",
    );
    const stream = response.getReadableStream();
    const chunks: Buffer[] = [];
    let byteLength = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      stream.destroy?.(new Error("Feishu inbound resource stream timeout"));
    }, this.options.inboundTimeoutMs);
    timer.unref?.();
    try {
      for await (const chunk of stream) {
        const bytes = normalizeStreamChunk(chunk);
        byteLength += bytes.length;
        if (byteLength > this.options.inboundMaxFileBytes) {
          stream.destroy?.(new Error("Feishu inbound resource exceeds local size limit"));
          throw new Error(`Feishu inbound resource exceeds ${String(this.options.inboundMaxFileBytes)} bytes`);
        }
        chunks.push(bytes);
      }
    } catch (error) {
      if (timedOut) {
        throw new Error(`Feishu inbound resource stream timed out after ${String(this.options.inboundTimeoutMs)}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
    if (byteLength === 0) throw new Error("Feishu inbound resource was empty");

    const bytes = Buffer.concat(chunks, byteLength);
    const ordinal = String(index + 1).padStart(2, "0");
    const suffix = attachment.kind === "image"
      ? sniffImageExtension(bytes)
      : safeFileExtension(attachment.fileName);
    const localPath = join(directory, `${attachment.kind}-${ordinal}${suffix}`);
    await writeFile(localPath, bytes, { mode: 0o600 });
    return { ...attachment, localPath, byteLength };
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

  #dispatchStatusControl(
    message: Extract<FeishuWorkerMessage, { type: "status-control" }>,
  ): void {
    const onMessage = this.#onMessage;
    if (!onMessage || this.#stopped) return;

    const value = message.action;
    const expectedExternalUserId = this.#conversationUsers.get(value.conversationId);
    if (expectedExternalUserId !== value.externalUserId) {
      process.stderr.write("feishu.transport.status_control_ignored=scope-mismatch\n");
      return;
    }

    const receivedAt = new Date(value.receivedAtMs);
    if (!Number.isFinite(receivedAt.getTime())) {
      process.stderr.write("feishu.transport.status_control_ignored=invalid-time\n");
      return;
    }

    process.stderr.write(
      `feishu.transport.status_control=received action=${value.action}\n`,
    );
    void onMessage({
      id: `feishu-status-control:${value.eventId}`,
      identity: {
        transport: "feishu",
        botId: this.options.appId,
        externalUserId: value.externalUserId,
        conversationId: value.conversationId,
      },
      text: `${STATUS_CONTROL_MESSAGE_PREFIX} ${value.action}`,
      receivedAt,
    }).catch((error) => {
      process.stderr.write(
        `feishu.transport.status_control_handler_error=${errorName(error)}\n`,
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
    ["inboundMaxFileBytes", options.inboundMaxFileBytes],
    ["inboundMaxAttachments", options.inboundMaxAttachments],
    ["inboundTimeoutMs", options.inboundTimeoutMs],
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
  if (!options.inboundRoot.trim()) throw new Error("Feishu inbound root must not be empty");
  if (options.projectInboundRoot !== undefined && !options.projectInboundRoot.trim()) {
    throw new Error("Feishu project inbound root must not be empty");
  }
  if (options.inboundMaxFileBytes > 100 * 1024 * 1024) {
    throw new Error("Feishu inbound file limit exceeds the platform 100 MiB ceiling");
  }
  if (options.inboundMaxAttachments > 16) throw new Error("Feishu inbound attachment count exceeds 16");
  if (options.inboundTimeoutMs > 10 * 60_000) throw new Error("Feishu inbound timeout exceeds 10 minutes");
}

function normalizeStreamChunk(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === "string") return Buffer.from(value, "utf8");
  throw new Error("Feishu inbound resource emitted an unsupported stream chunk");
}

function safeFileExtension(fileName: string | undefined): string {
  if (!fileName) return ".bin";
  const suffix = extname(fileName).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/u.test(suffix) ? suffix : ".bin";
}

function sniffImageExtension(bytes: Buffer): string {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ".png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return ".jpg";
  if (bytes.length >= 6) {
    const header = bytes.subarray(0, 6).toString("ascii");
    if (header === "GIF87a" || header === "GIF89a") return ".gif";
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return ".webp";
  if (bytes.length >= 2 && bytes.subarray(0, 2).toString("ascii") === "BM") return ".bmp";
  return ".bin";
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

function readFeishuResponseMessageId(value: unknown): string | undefined {
  assertFeishuApiSuccess(value);
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const direct = record.message_id;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const data = record.data;
  if (typeof data === "object" && data !== null) {
    const nested = (data as Record<string, unknown>).message_id;
    if (typeof nested === "string" && nested.trim()) return nested.trim();
  }
  return undefined;
}

function feishuDeliveryUuid(idempotencyKey: string, part: number): string {
  return createHash("sha256")
    .update("floral-delivery\0", "utf8")
    .update(idempotencyKey, "utf8")
    .update("\0", "utf8")
    .update(String(part), "utf8")
    .digest("hex")
    .slice(0, 32);
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
