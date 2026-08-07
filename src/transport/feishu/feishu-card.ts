import type { InteractiveApprovalPrompt } from "../../core/contracts.js";

export type FeishuApprovalDecision = "approve" | "deny";

export interface FeishuCardActionEvent {
  event_id?: string | undefined;
  create_time?: string | undefined;
  app_id?: string | undefined;
  operator?: {
    open_id?: string | undefined;
  } | undefined;
  action?: {
    tag?: string | undefined;
    value?: unknown;
  } | undefined;
  host?: string | undefined;
  context?: {
    open_message_id?: string | undefined;
    open_chat_id?: string | undefined;
  } | undefined;
}

export interface NormalizedFeishuApprovalAction {
  eventId: string;
  appId: string;
  externalUserId: string;
  conversationId: string;
  messageId?: string | undefined;
  approvalId: string;
  decision: FeishuApprovalDecision;
  receivedAt: Date;
}

interface FeishuApprovalActionValue {
  floral_action: "approval";
  approval_id: string;
  decision: FeishuApprovalDecision;
}

export function buildFeishuApprovalCard(
  prompt: InteractiveApprovalPrompt,
): Record<string, unknown> {
  const approvalId = normalizeApprovalId(prompt.approvalId);
  const seconds = Math.max(1, Math.ceil(prompt.ttlMs / 1_000));
  const summary = boundedText(prompt.summary, 800);
  const capability = boundedText(prompt.capability, 96);
  const action = capability === "files.write"
    ? "FLORAL 想修改工作区文件。"
    : "FLORAL 请求执行一个需要确认的操作。";

  return {
    schema: "2.0",
    config: {
      update_multi: true,
      enable_forward: false,
    },
    header: {
      template: "orange",
      title: {
        tag: "plain_text",
        content: "需要你的确认",
      },
      subtitle: {
        tag: "plain_text",
        content: "FLORAL",
      },
    },
    body: {
      elements: [
        {
          tag: "markdown",
          element_id: "approval_summary",
          content: [
            `**${escapeMarkdown(action)}**`,
            "",
            escapeMarkdown(summary),
            "",
            `能力：\`${escapeInlineCode(capability)}\``,
            `有效期：${String(seconds)} 秒`,
          ].join("\n"),
        },
        {
          tag: "column_set",
          element_id: "approval_actions",
          flex_mode: "bisect",
          horizontal_spacing: "8px",
          columns: [
            {
              tag: "column",
              element_id: "approve_column",
              width: "weighted",
              weight: 1,
              elements: [
                approvalButton(
                  "approve_button",
                  "允许一次",
                  "primary_filled",
                  approvalId,
                  "approve",
                ),
              ],
            },
            {
              tag: "column",
              element_id: "deny_column",
              width: "weighted",
              weight: 1,
              elements: [
                approvalButton(
                  "deny_button",
                  "拒绝",
                  "danger",
                  approvalId,
                  "deny",
                ),
              ],
            },
          ],
        },
      ],
    },
  };
}

export function normalizeFeishuApprovalCardAction(
  event: FeishuCardActionEvent,
  expectedAppId: string,
): NormalizedFeishuApprovalAction | undefined {
  const appId = event.app_id?.trim();
  const eventId = event.event_id?.trim();
  const externalUserId = event.operator?.open_id?.trim();
  const conversationId = event.context?.open_chat_id?.trim();
  const messageId = event.context?.open_message_id?.trim();
  const expected = expectedAppId.trim();

  if (
    !expected
    || !appId
    || appId !== expected
    || !eventId
    || !externalUserId
    || !conversationId
    || event.host !== "im_message"
    || event.action?.tag !== "button"
  ) {
    return undefined;
  }

  const value = readApprovalActionValue(event.action.value);
  if (!value) return undefined;

  return {
    eventId,
    appId,
    externalUserId,
    conversationId,
    ...(messageId ? { messageId } : {}),
    approvalId: value.approval_id,
    decision: value.decision,
    receivedAt: parseCallbackCreateTime(event.create_time),
  };
}

function approvalButton(
  elementId: string,
  label: string,
  type: "primary_filled" | "danger",
  approvalId: string,
  decision: FeishuApprovalDecision,
): Record<string, unknown> {
  const value: FeishuApprovalActionValue = {
    floral_action: "approval",
    approval_id: approvalId,
    decision,
  };

  return {
    tag: "button",
    element_id: elementId,
    text: {
      tag: "plain_text",
      content: label,
    },
    type,
    width: "fill",
    behaviors: [
      {
        type: "callback",
        value,
      },
    ],
  };
}

function readApprovalActionValue(value: unknown): FeishuApprovalActionValue | undefined {
  if (!isRecord(value)) return undefined;
  if (value.floral_action !== "approval") return undefined;

  const rawApprovalId = typeof value.approval_id === "string"
    ? value.approval_id.trim().toUpperCase()
    : "";
  if (!/^[A-Z0-9]{6,24}$/u.test(rawApprovalId)) return undefined;

  const decision = value.decision;
  if (decision !== "approve" && decision !== "deny") return undefined;

  return {
    floral_action: "approval",
    approval_id: rawApprovalId,
    decision,
  };
}

function normalizeApprovalId(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{6,24}$/u.test(normalized)) {
    throw new Error("Feishu approval ID must contain 6-24 uppercase alphanumeric characters");
  }
  return normalized;
}

function parseCallbackCreateTime(value: string | undefined): Date {
  if (typeof value === "string" && /^\d{10,17}$/u.test(value)) {
    const numeric = Number(value);
    if (Number.isSafeInteger(numeric)) {
      // New callback examples use microseconds; tolerate millisecond values too.
      const millis = value.length >= 16 ? Math.floor(numeric / 1_000) : numeric;
      const parsed = new Date(millis);
      if (Number.isFinite(parsed.getTime())) return parsed;
    }
  }
  return new Date();
}

function boundedText(value: string, maxCharacters: number): string {
  const normalized = value
    .replace(/[\u0000-\u001F\u007F]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (normalized.length <= maxCharacters) return normalized;
  return `${normalized.slice(0, Math.max(0, maxCharacters - 3))}...`;
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_{}\[\]()#+\-.!|>~])/gu, "\\$1");
}

function escapeInlineCode(value: string): string {
  return value.replace(/[`\\]/gu, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
