import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  FileKVStore,
  QQBot,
  kvSessionPersistence,
  type MiddlewareContext,
  type QQBotInboundMessage,
  type ReplyTarget,
} from "@tencent-connect/qqbot-nodejs";
import type {
  ChatTransport,
  ConversationActivityState,
  ConversationActivityTransport,
} from "../../core/contracts.js";
import type { IncomingMessage, OutgoingMessage } from "../../core/types.js";
import { ReplyTargetCache } from "./reply-target-cache.js";
import { presentQqText } from "./qq-presentation.js";
import { splitQqText } from "./qq-text.js";

interface QqBotClient {
  on(event: "ready" | "resumed", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(
    event: "message",
    listener: (
      context: MiddlewareContext,
      message: QQBotInboundMessage,
    ) => Promise<void>,
  ): void;
  start(signal?: AbortSignal): Promise<void>;
  stop(): void | Promise<void>;
  sendText(target: ReplyTarget, text: string): Promise<unknown>;
  sendTyping(target: ReplyTarget): Promise<unknown>;
}

export interface QqTransportDiagnostics {
  state: "idle" | "starting" | "ready" | "stopped" | "error";
  readyCount: number;
  resumedCount: number;
  inboundMessages: number;
  outboundChunks: number;
  deliveryFailures: number;
  typingSignals: number;
  typingFailures: number;
  activeTypingConversations: number;
  sequencedConversations: number;
  cachedReplyTargets: number;
  lastErrorType?: string | undefined;
}

export interface QqSdkRuntimePolicy {
  accountIdStrategy: "sha256-app-id";
  sessionPersistence: "file";
  tokenPrefetch: "sync" | "async";
  logger: "redacted";
}

export interface QqTransportOptions {
  appId: string;
  appSecret: string;
  dataDir: string;
  startupTimeoutMs: number;
  replyTargetTtlMs: number;
  replyTargetCacheEntries: number;
  textChunkCharacters: number;
  maxReplyChunks: number;
  outboundTimeoutMs: number;
  sdk: QqSdkRuntimePolicy;
  createBot?: (() => QqBotClient | Promise<QqBotClient>) | undefined;
  now?: (() => number) | undefined;
}

export class QqReplyTargetUnavailableError extends Error {
  constructor() {
    super("QQ passive reply target is missing or expired");
    this.name = "QqReplyTargetUnavailableError";
  }
}

export class QqDeliveryError extends Error {
  readonly chunkIndex: number;
  readonly chunkCount: number;

  constructor(chunkIndex: number, chunkCount: number, cause: unknown) {
    super(`QQ text delivery failed at chunk ${chunkIndex}/${chunkCount}`, {
      cause,
    });
    this.name = "QqDeliveryError";
    this.chunkIndex = chunkIndex;
    this.chunkCount = chunkCount;
  }
}

const QQ_TYPING_REFRESH_MS = 50_000;
const QQ_TYPING_TIMEOUT_CAP_MS = 2_000;

interface TypingSession {
  timer?: ReturnType<typeof setTimeout> | undefined;
}

export class QqTransport implements ChatTransport, ConversationActivityTransport {
  readonly name = "qq-open-platform";
  readonly #replyTargets: ReplyTargetCache<ReplyTarget>;
  readonly #outboundTails = new Map<string, Promise<void>>();
  readonly #typingSessions = new Map<string, TypingSession>();
  #bot: QqBotClient | undefined;
  #abortController: AbortController | undefined;
  #runPromise: Promise<void> | undefined;
  #diagnostics: QqTransportDiagnostics = {
    state: "idle",
    readyCount: 0,
    resumedCount: 0,
    inboundMessages: 0,
    outboundChunks: 0,
    deliveryFailures: 0,
    typingSignals: 0,
    typingFailures: 0,
    activeTypingConversations: 0,
    sequencedConversations: 0,
    cachedReplyTargets: 0,
  };

  constructor(private readonly options: QqTransportOptions) {
    this.#replyTargets = new ReplyTargetCache(
      options.replyTargetTtlMs,
      options.replyTargetCacheEntries,
      options.now,
    );
  }

  snapshot(): QqTransportDiagnostics {
    return {
      ...this.#diagnostics,
      cachedReplyTargets: this.#replyTargets.size(),
      activeTypingConversations: this.#typingSessions.size,
      sequencedConversations: this.#outboundTails.size,
    };
  }

  async start(
    onMessage: (message: IncomingMessage) => Promise<void>,
  ): Promise<void> {
    if (this.#diagnostics.state === "ready") return;
    if (this.#diagnostics.state === "starting") {
      throw new Error("QQ transport is already starting");
    }
    if (this.#diagnostics.state === "stopped") {
      throw new Error("QQ transport cannot be restarted after stop");
    }

    this.#diagnostics = {
      ...this.#diagnostics,
      state: "starting",
      lastErrorType: undefined,
    };

    const bot = await this.#createBot();
    this.#bot = bot;
    const abortController = new AbortController();
    this.#abortController = abortController;

    let settleReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolvePromise, rejectPromise) => {
      settleReady = resolvePromise;
      rejectReady = rejectPromise;
    });
    let startupSettled = false;

    const markReady = (resumed: boolean) => {
      this.#diagnostics = {
        ...this.#diagnostics,
        state: "ready",
        readyCount: this.#diagnostics.readyCount + (resumed ? 0 : 1),
        resumedCount: this.#diagnostics.resumedCount + (resumed ? 1 : 0),
        lastErrorType: undefined,
      };
      process.stderr.write(
        resumed ? "qq.transport.resumed=ok\n" : "qq.transport.ready=ok\n",
      );
      if (!startupSettled) {
        startupSettled = true;
        settleReady();
      }
    };

    bot.on("ready", () => markReady(false));
    bot.on("resumed", () => markReady(true));
    bot.on("error", (error) => {
      this.#diagnostics = {
        ...this.#diagnostics,
        state: "error",
        lastErrorType: safeErrorType(error),
      };
      process.stderr.write(
        `qq.transport.error=${safeErrorType(error)}\n`,
      );
      if (!startupSettled) {
        startupSettled = true;
        rejectReady(new Error(
          `QQ transport failed before ready: ${safeErrorType(error)}`,
          { cause: error },
        ));
      }
    });

    bot.on("message", async (_context, message) => {
      try {
        await this.#handleInbound(message, onMessage);
      } catch (error) {
        process.stderr.write(
          `qq.transport.inbound_error=${safeErrorType(error)}\n`,
        );
      }
    });

    this.#runPromise = bot.start(abortController.signal);
    void this.#runPromise.catch((error) => {
      if (abortController.signal.aborted) return;
      this.#diagnostics = {
        ...this.#diagnostics,
        state: "error",
        lastErrorType: safeErrorType(error),
      };
      process.stderr.write(
        `qq.transport.run_error=${safeErrorType(error)}\n`,
      );
      if (!startupSettled) {
        startupSettled = true;
        rejectReady(new Error(
          `QQ transport start failed: ${safeErrorType(error)}`,
          { cause: error },
        ));
      }
    });

    try {
      await withTimeout(
        ready,
        this.options.startupTimeoutMs,
        "QQ transport startup",
      );
    } catch (error) {
      abortController.abort();
      await Promise.allSettled([bot.stop(), this.#runPromise]);
      this.#bot = undefined;
      this.#runPromise = undefined;
      this.#diagnostics = {
        ...this.#diagnostics,
        state: "error",
        lastErrorType: safeErrorType(error),
      };
      throw error;
    }
  }

  async send(message: OutgoingMessage): Promise<void> {
    const bot = this.#bot;
    if (!bot || this.#diagnostics.state !== "ready") {
      throw new Error("QQ transport is not ready");
    }

    const cached = this.#replyTargets.get(message.conversationId);
    if (!cached) throw new QqReplyTargetUnavailableError();

    this.#stopTypingSession(message.conversationId);
    const presentedText = presentQqText(message.text);
    const chunks = splitQqText(presentedText, {
      maxCharacters: this.options.textChunkCharacters,
      maxChunks: this.options.maxReplyChunks,
    });

    await this.#sequenceOutbound(message.conversationId, async () => {
      for (const [zeroBasedIndex, chunk] of chunks.entries()) {
        const chunkIndex = zeroBasedIndex + 1;
        try {
          await withTimeout(
            bot.sendText(
              {
                ...cached.target,
                msgId: cached.messageId,
              },
              chunk,
            ),
            this.options.outboundTimeoutMs,
            `QQ outbound chunk ${chunkIndex}`,
          );
          this.#diagnostics = {
            ...this.#diagnostics,
            outboundChunks: this.#diagnostics.outboundChunks + 1,
          };
        } catch (error) {
          this.#diagnostics = {
            ...this.#diagnostics,
            deliveryFailures: this.#diagnostics.deliveryFailures + 1,
            lastErrorType: safeErrorType(error),
          };
          throw new QqDeliveryError(chunkIndex, chunks.length, error);
        }
      }
    });
  }

  async setConversationActivity(
    conversationId: string,
    state: ConversationActivityState,
  ): Promise<void> {
    if (state === "idle") {
      this.#stopTypingSession(conversationId);
      return;
    }

    if (this.#typingSessions.has(conversationId)) return;
    this.#typingSessions.set(conversationId, {});
    await this.#sendTypingSignal(conversationId);
    this.#scheduleTypingRefresh(conversationId);
  }

  async stop(): Promise<void> {
    if (this.#diagnostics.state === "stopped") return;
    this.#stopAllTypingSessions();
    this.#abortController?.abort();
    const bot = this.#bot;
    this.#bot = undefined;
    this.#replyTargets.clear();

    await Promise.allSettled([
      bot?.stop(),
      this.#runPromise,
    ]);

    this.#runPromise = undefined;
    this.#abortController = undefined;
    this.#outboundTails.clear();
    this.#diagnostics = {
      ...this.#diagnostics,
      state: "stopped",
      cachedReplyTargets: 0,
      activeTypingConversations: 0,
      sequencedConversations: 0,
    };
  }

  async #sendTypingSignal(conversationId: string): Promise<void> {
    const bot = this.#bot;
    if (!bot || this.#diagnostics.state !== "ready") return;

    const cached = this.#replyTargets.get(conversationId);
    if (!cached) {
      this.#stopTypingSession(conversationId);
      return;
    }

    try {
      await this.#sequenceOutbound(conversationId, () => withTimeout(
        bot.sendTyping(cached.target),
        Math.min(this.options.outboundTimeoutMs, QQ_TYPING_TIMEOUT_CAP_MS),
        "QQ typing indicator",
      ));
      this.#diagnostics = {
        ...this.#diagnostics,
        typingSignals: this.#diagnostics.typingSignals + 1,
      };
    } catch (error) {
      this.#diagnostics = {
        ...this.#diagnostics,
        typingFailures: this.#diagnostics.typingFailures + 1,
      };
      process.stderr.write(
        `qq.transport.typing_error=${safeErrorType(error)}\n`,
      );
    }
  }

  #scheduleTypingRefresh(conversationId: string): void {
    const session = this.#typingSessions.get(conversationId);
    if (!session || session.timer) return;

    const timer = setTimeout(() => {
      const current = this.#typingSessions.get(conversationId);
      if (!current) return;
      current.timer = undefined;
      void this.#sendTypingSignal(conversationId).finally(() => {
        if (this.#typingSessions.has(conversationId)) {
          this.#scheduleTypingRefresh(conversationId);
        }
      });
    }, QQ_TYPING_REFRESH_MS);
    timer.unref?.();
    session.timer = timer;
  }

  #stopTypingSession(conversationId: string): void {
    const session = this.#typingSessions.get(conversationId);
    if (!session) return;
    if (session.timer) clearTimeout(session.timer);
    this.#typingSessions.delete(conversationId);
  }

  #stopAllTypingSessions(): void {
    for (const conversationId of this.#typingSessions.keys()) {
      this.#stopTypingSession(conversationId);
    }
  }

  async #sequenceOutbound<T>(
    conversationId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#outboundTails.get(conversationId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const tail = current.then(() => undefined, () => undefined);
    this.#outboundTails.set(conversationId, tail);

    try {
      return await current;
    } finally {
      if (this.#outboundTails.get(conversationId) === tail) {
        this.#outboundTails.delete(conversationId);
      }
    }
  }

  async #handleInbound(
    message: QQBotInboundMessage,
    onMessage: (message: IncomingMessage) => Promise<void>,
  ): Promise<void> {
    if (message.replyTarget.scope !== "c2c") {
      process.stderr.write("qq.transport.ignored_scope=non-c2c\n");
      return;
    }

    const messageId = message.messageId?.trim();
    const externalUserId = message.senderId?.trim();
    const conversationId = message.replyTarget.targetId?.trim();
    const text = message.content?.trim() ?? "";

    if (!messageId || !externalUserId || !conversationId || !text) {
      process.stderr.write("qq.transport.ignored_message=incomplete\n");
      return;
    }

    this.#replyTargets.set(
      conversationId,
      message.replyTarget,
      messageId,
    );
    this.#diagnostics = {
      ...this.#diagnostics,
      inboundMessages: this.#diagnostics.inboundMessages + 1,
      cachedReplyTargets: this.#replyTargets.size(),
    };

    await onMessage({
      id: messageId,
      identity: {
        transport: "qq",
        botId: this.options.appId,
        externalUserId,
        conversationId,
        ...(message.senderName
          ? { displayName: message.senderName }
          : {}),
      },
      text,
      receivedAt: new Date(),
    });
  }

  async #createBot(): Promise<QqBotClient> {
    if (this.options.createBot) return await this.options.createBot();

    validateSdkRuntimePolicy(this.options.sdk);
    const accountId = accountFingerprint(this.options.appId);
    const sessionDir = resolve(this.options.dataDir, "qq", accountId);
    await mkdir(sessionDir, { recursive: true });

    return new QQBot({
      appId: this.options.appId,
      appSecret: this.options.appSecret,
      accountId,
      sessionPersistence: kvSessionPersistence({
        store: new FileKVStore({
          dir: sessionDir,
          fileName: "session.json",
        }),
        accountId,
      }),
      tokenPrefetch: this.options.sdk.tokenPrefetch,
      logger: createRedactedLogger(),
    });
  }
}

function validateSdkRuntimePolicy(policy: QqSdkRuntimePolicy): void {
  if (policy.accountIdStrategy !== "sha256-app-id") {
    throw new Error("Unsupported QQ account ID strategy");
  }
  if (policy.sessionPersistence !== "file") {
    throw new Error("Unsupported QQ session persistence mode");
  }
  if (!new Set(["sync", "async"]).has(policy.tokenPrefetch)) {
    throw new Error("Unsupported QQ token prefetch mode");
  }
  if (policy.logger !== "redacted") {
    throw new Error("QQ SDK logger must remain redacted");
  }
}

function accountFingerprint(appId: string): string {
  return `floral-${createHash("sha256").update(appId).digest("hex").slice(0, 16)}`;
}

function createRedactedLogger(): {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
} {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => process.stderr.write("qq.sdk.warn=reported\n"),
    error: () => process.stderr.write("qq.sdk.error=reported\n"),
  };
}

function safeErrorType(error: unknown): string {
  if (error instanceof Error && error.name.trim()) return error.name;
  return "Error";
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`${label} timeout must be a positive integer`);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
