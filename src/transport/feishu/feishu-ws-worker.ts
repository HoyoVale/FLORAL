import { parentPort, workerData } from "node:worker_threads";
import * as Lark from "@larksuiteoapi/node-sdk";
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
        receivedAtMs: normalized.receivedAt.getTime(),
      },
    });
    return {};
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

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid Feishu worker ${label}`);
  }
  return value.trim();
}

function errorName(error: unknown): string {
  return error instanceof Error && error.name.trim() ? error.name : "Error";
}
