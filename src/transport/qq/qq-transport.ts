import { randomUUID } from "node:crypto";
import type { ChatTransport } from "../../core/contracts.js";
import type { IncomingMessage, OutgoingMessage } from "../../core/types.js";

interface QQMessage {
  id?: string;
  content?: string;
  author?: { id?: string; username?: string };
  replyTarget?: unknown;
  conversationId?: string;
}

interface QQBotLike {
  on(event: "message", listener: (context: unknown, message: QQMessage) => Promise<void>): void;
  start(): Promise<void>;
  stop?(): Promise<void>;
  sendText(target: unknown, text: string): Promise<void>;
}

export interface QqTransportOptions {
  appId: string;
  appSecret: string;
}

export class QqTransport implements ChatTransport {
  readonly name = "qq-open-platform";
  #bot?: QQBotLike;
  readonly #replyTargets = new Map<string, unknown>();

  constructor(private readonly options: QqTransportOptions) {}

  async start(onMessage: (message: IncomingMessage) => Promise<void>): Promise<void> {
    const packageName = "@tencent-connect/qqbot-nodejs";
    const module = await import(packageName) as {
      QQBot: new (options: { appId: string; appSecret: string; logger: Console }) => QQBotLike;
    };
    const bot = new module.QQBot({ ...this.options, logger: console });
    this.#bot = bot;

    bot.on("message", async (_context, message) => {
      const externalUserId = message.author?.id;
      if (!externalUserId || !message.replyTarget) return;
      const conversationId = message.conversationId ?? externalUserId;
      this.#replyTargets.set(conversationId, message.replyTarget);
      await onMessage({
        id: message.id ?? randomUUID(),
        identity: {
          transport: "qq",
          botId: this.options.appId,
          externalUserId,
          conversationId,
          ...(message.author?.username ? { displayName: message.author.username } : {})
        },
        text: message.content?.trim() ?? "",
        receivedAt: new Date()
      });
    });

    await bot.start();
  }

  async send(message: OutgoingMessage): Promise<void> {
    const target = this.#replyTargets.get(message.conversationId);
    if (!target || !this.#bot) throw new Error(`No QQ reply target for ${message.conversationId}`);
    await this.#bot.sendText(target, message.text);
  }

  async stop(): Promise<void> {
    await this.#bot?.stop?.();
  }
}
