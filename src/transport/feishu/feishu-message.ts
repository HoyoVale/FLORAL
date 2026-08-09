import type {
  IncomingAttachment,
  IncomingMessage,
} from "../../core/types.js";

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
 * Convert Feishu im.message.receive_v1 into FLORAL's transport-neutral ingress
 * contract. The worker parses metadata only; binary resources stay remote refs
 * until Gateway authenticates the sender.
 */
export function normalizeFeishuMessageEvent(
  event: FeishuMessageEvent,
  botId: string,
): IncomingMessage | undefined {
  const sender = event.sender;
  const message = event.message;

  if (sender?.sender_type !== "user") return undefined;
  if (message?.chat_type !== "p2p") return undefined;

  const externalUserId = sender.sender_id?.open_id?.trim();
  const messageId = message.message_id?.trim();
  const chatId = message.chat_id?.trim();
  const normalizedBotId = botId.trim();
  if (!externalUserId || !messageId || !chatId || !normalizedBotId) return undefined;

  const content = parseJsonObject(message.content);
  if (!content) return undefined;
  const normalized = normalizeContent(message.message_type?.trim(), content, messageId);
  if (!normalized) return undefined;

  return {
    id: messageId,
    identity: {
      transport: "feishu",
      botId: normalizedBotId,
      externalUserId,
      conversationId: chatId,
    },
    text: normalized.text,
    ...(normalized.attachments.length > 0 ? { attachments: normalized.attachments } : {}),
    receivedAt: parseCreateTime(message.create_time),
  };
}

function normalizeContent(
  messageType: string | undefined,
  content: Record<string, unknown>,
  messageId: string,
): { text: string; attachments: IncomingAttachment[] } | undefined {
  if (messageType === "text") {
    return typeof content.text === "string" ? { text: content.text, attachments: [] } : undefined;
  }
  if (messageType === "image") {
    const key = nonEmptyString(content.image_key);
    return key ? { text: "", attachments: [attachment("image", messageId, key)] } : undefined;
  }
  if (messageType === "file") {
    const key = nonEmptyString(content.file_key);
    if (!key) return undefined;
    return {
      text: "",
      attachments: [attachment("file", messageId, key, nonEmptyString(content.file_name))],
    };
  }
  if (messageType === "post") return normalizePostContent(content, messageId);
  return undefined;
}

function normalizePostContent(
  content: Record<string, unknown>,
  messageId: string,
): { text: string; attachments: IncomingAttachment[] } | undefined {
  const text: string[] = [];
  const attachments: IncomingAttachment[] = [];
  const seen = new Set<string>();

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const record = value as Record<string, unknown>;
    const tag = nonEmptyString(record.tag);
    const title = nonEmptyString(record.title);
    if (title) text.push(title);
    if (
      (tag === "text" || tag === "a" || tag === "code_block" || tag === "md")
      && typeof record.text === "string"
    ) {
      text.push(record.text);
    } else if (tag === "at") {
      const userName = nonEmptyString(record.user_name);
      if (userName) text.push(`@${userName}`);
    }
    if (tag === "img") {
      const key = nonEmptyString(record.image_key);
      if (key && !seen.has(key)) {
        seen.add(key);
        attachments.push(attachment("image", messageId, key));
      }
    }
    for (const [key, child] of Object.entries(record)) {
      if (["tag", "title", "text", "user_name", "image_key"].includes(key)) continue;
      visit(child);
    }
  };

  visit(content);
  const normalizedText = text.join("\n").trim();
  return normalizedText || attachments.length > 0
    ? { text: normalizedText, attachments }
    : undefined;
}

function attachment(
  kind: "image" | "file",
  messageId: string,
  resourceKey: string,
  fileName?: string,
): IncomingAttachment {
  return {
    id: `${kind}:${resourceKey}`,
    kind,
    ...(fileName ? { fileName } : {}),
    source: { transport: "feishu", messageId, resourceKey },
  };
}

function parseJsonObject(value: string | undefined): Record<string, unknown> | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
