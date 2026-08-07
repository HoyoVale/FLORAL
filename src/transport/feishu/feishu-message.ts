import type { IncomingMessage } from "../../core/types.js";

export interface FeishuMessageEvent {
  sender?: {
    sender_id?: {
      open_id?: string | undefined;
    } | undefined;
    sender_type?: string | undefined;
  } | undefined;
  message?: {
    message_id?: string | undefined;
    chat_id?: string | undefined;
    chat_type?: string | undefined;
    message_type?: string | undefined;
    content?: string | undefined;
    create_time?: string | undefined;
  } | undefined;
}

/**
 * Convert Feishu's im.message.receive_v1 event payload into FLORAL's transport-neutral
 * IncomingMessage contract.
 *
 * Phase 5F.1 intentionally accepts only user -> bot P2P text messages. Group chat,
 * bot-originated messages, rich media, and malformed payloads fail closed.
 */
export function normalizeFeishuMessageEvent(
  event: FeishuMessageEvent,
  botId: string,
): IncomingMessage | undefined {
  const sender = event.sender;
  const message = event.message;

  if (sender?.sender_type !== "user") return undefined;
  if (message?.chat_type !== "p2p") return undefined;
  if (message.message_type !== "text") return undefined;

  const externalUserId = sender.sender_id?.open_id?.trim();
  const messageId = message.message_id?.trim();
  const chatId = message.chat_id?.trim();
  const normalizedBotId = botId.trim();

  if (!externalUserId || !messageId || !chatId || !normalizedBotId) {
    return undefined;
  }

  const text = parseTextContent(message.content);
  if (text === undefined) return undefined;

  return {
    id: messageId,
    identity: {
      transport: "feishu",
      botId: normalizedBotId,
      externalUserId,
      conversationId: chatId,
    },
    text,
    receivedAt: parseCreateTime(message.create_time),
  };
}

function parseTextContent(content: string | undefined): string | undefined {
  if (typeof content !== "string") return undefined;
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    return typeof parsed.text === "string" ? parsed.text : undefined;
  } catch {
    return undefined;
  }
}

function parseCreateTime(value: string | undefined): Date {
  if (typeof value === "string" && /^\d{10,17}$/u.test(value)) {
    const millis = Number(value);
    if (Number.isSafeInteger(millis)) {
      const date = new Date(millis);
      if (Number.isFinite(date.getTime())) return date;
    }
  }
  return new Date();
}
