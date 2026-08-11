import { parentPort, workerData } from "node:worker_threads";
import * as Lark from "@larksuiteoapi/node-sdk";
import {
  normalizeFeishuApprovalCardAction,
  type FeishuCardActionEvent,
} from "./feishu-card.js";
import {
  normalizeFeishuStatusControlCardAction,
} from "./feishu-status-card.js";
import {
  normalizeFeishuMessageEvent,
  type FeishuMessageEvent,
} from "./feishu-message.js";
import type {
  FeishuWorkerConfig,
  FeishuWorkerMessage,
} from "./feishu-worker-protocol.js";

if (!parentPort) throw new Error("Feishu WS worker requires a parent port");
const port = parentPort;

const config = workerData as Partial<FeishuWorkerConfig>;
const appId = requireString(config.appId, "appId");
const appSecret = requireString(config.appSecret, "appSecret");

const eventDispatcher = new Lark.EventDispatcher({}).register({
  "im.message.receive_v1": async (data) => {
    const normalized = normalizeFeishuMessageEvent(
      data as FeishuMessageEvent,
      appId,
    );
    if (!normalized) return {};

    // The Feishu long-connection contract expects event handlers to return quickly.
    // Only normalization and IPC happen here; Gateway/Codex work runs in the parent.
    post({
      type: "message",
      message: {
        id: normalized.id,
        botId: normalized.identity.botId,
        externalUserId: normalized.identity.externalUserId,
        conversationId: normalized.identity.conversationId,
        text: normalized.text,
        ...(normalized.attachments?.length ? {
          attachments: normalized.attachments.map((attachment) => ({
            id: attachment.id,
            kind: attachment.kind,
            resourceKey: attachment.source.resourceKey,
            ...(attachment.fileName ? { fileName: attachment.fileName } : {}),
          })),
        } : {}),
        receivedAtMs: normalized.receivedAt.getTime(),
      },
    });
    return {};
  },

  "card.action.trigger": async (data: unknown) => {
    const action = normalizeFeishuApprovalCardAction(
      data as FeishuCardActionEvent,
      appId,
    );
    if (action) {
      // The callback response must return immediately. Parent-process routing still
      // validates the short-lived approval route before entering Gateway.
      post({
        type: "card-action",
        action: {
          eventId: action.eventId,
          externalUserId: action.externalUserId,
          conversationId: action.conversationId,
          approvalId: action.approvalId,
          decision: action.decision,
          receivedAtMs: action.receivedAt.getTime(),
        },
      });
      return callbackToast("success", "审批操作已收到，FLORAL 正在处理");
    }

    const statusControl = normalizeFeishuStatusControlCardAction(
      data as Parameters<typeof normalizeFeishuStatusControlCardAction>[0],
      appId,
    );
    if (statusControl) {
      post({
        type: "status-control",
        action: {
          eventId: statusControl.eventId,
          externalUserId: statusControl.externalUserId,
          conversationId: statusControl.conversationId,
          action: statusControl.action,
          receivedAtMs: statusControl.receivedAt.getTime(),
        },
      });
      return callbackToast("success", "操作已收到，FLORAL 正在处理");
    }

    return callbackToast("warning", "无法识别该卡片操作");
  },
});

const wsClient = new Lark.WSClient({
  appId,
  appSecret,
  loggerLevel: Lark.LoggerLevel.info,
});

try {
  const startResult = wsClient.start({ eventDispatcher });
  // SDK 1.36.0 may keep the start Promise pending for the lifetime of the
  // connection even though event delivery is active. Do not await it here.
  void Promise.resolve(startResult).catch((error: unknown) => {
    post({ type: "fatal", errorType: errorName(error) });
  });
  post({ type: "started" });
} catch (error) {
  post({ type: "fatal", errorType: errorName(error) });
}

function post(message: FeishuWorkerMessage): void {
  port.postMessage(message);
}

function callbackToast(
  type: "success" | "warning" | "error",
  content: string,
): Record<string, unknown> {
  return {
    toast: {
      type,
      content,
    },
  };
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid Feishu worker ${label}`);
  }
  return value.trim();
}

function errorName(error: unknown): string {
  return error instanceof Error && error.name.trim() ? error.name : "Error";
}
