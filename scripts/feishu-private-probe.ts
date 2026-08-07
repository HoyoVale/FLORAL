import * as Lark from "@larksuiteoapi/node-sdk";
import { loadProjectEnv } from "../src/config/load-project-env.js";
import {
  normalizeFeishuMessageEvent,
  type FeishuMessageEvent,
} from "../src/transport/feishu/feishu-message.js";

const DEFAULT_TIMEOUT_MS = 120_000;

loadProjectEnv();

const appId = requireSecret("FEISHU_APP_ID");
const appSecret = requireSecret("FEISHU_APP_SECRET");
const timeoutMs = parseTimeout(process.env.FEISHU_PROBE_TIMEOUT_MS);

const client = new Lark.Client({
  appId,
  appSecret,
});

const wsClient = new Lark.WSClient({
  appId,
  appSecret,
  loggerLevel: Lark.LoggerLevel.info,
});

let handled = false;
let settled = false;

const completion = new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => {
    reject(new Error(`Feishu private probe timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  const finish = (error?: unknown) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) reject(error);
    else resolve();
  };

  const eventDispatcher = new Lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (data) => {
      const normalized = normalizeFeishuMessageEvent(
        data as FeishuMessageEvent,
        appId,
      );
      if (!normalized) {
        console.log("feishu.private_probe.event=ignored");
        return {};
      }
      if (handled) {
        console.log("feishu.private_probe.event=duplicate_ignored");
        return {};
      }
      handled = true;

      // Long-connection event handlers should return promptly. The actual send is
      // detached; message_id remains the FLORAL deduplication key for production.
      void (async () => {
        try {
          console.log("feishu.private_probe.inbound=p2p-text");
          console.log("feishu.private_probe.sender_open_id=present");
          console.log("feishu.private_probe.chat_id=present");
          console.log("feishu.private_probe.message_id=present");

          await client.im.v1.message.create({
            params: {
              receive_id_type: "chat_id",
            },
            data: {
              receive_id: normalized.identity.conversationId,
              msg_type: "text",
              content: JSON.stringify({
                text: "FLORAL 飞书单聊探针已收到消息。Feishu WebSocket + send message API 正常。",
              }),
            },
          });

          console.log("feishu.private_probe.reply=ok");
          finish();
        } catch (error) {
          finish(error);
        }
      })();

      return {};
    },
  });

  try {
    console.log("feishu.private_probe.mode=direct-sdk-p2p");
    console.log("feishu.private_probe.gateway=bypassed");
    console.log("feishu.private_probe.codex=bypassed");
    console.log("feishu.private_probe.deepseek=bypassed");
    console.log("feishu.private_probe.waiting=true");
    console.log("feishu.private_probe.instructions=send-one-private-text-message-to-the-bot");
    wsClient.start({ eventDispatcher });
  } catch (error) {
    finish(error);
  }
});

try {
  await completion;
  console.log("feishu.private_probe.result=ok");
  // WSClient 1.36.0 does not expose a stable shutdown contract that FLORAL has
  // adopted yet. This is an exclusive diagnostic process, so exit only after the
  // reply has completed. Production transport lifecycle is deferred to Phase 5F.2.
  setTimeout(() => process.exit(0), 50);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`feishu.private_probe.result=error:${sanitize(message)}`);
  setTimeout(() => process.exit(1), 50);
}

function requireSecret(name: "FEISHU_APP_ID" | "FEISHU_APP_SECRET"): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for the direct Feishu probe`);
  }
  return value;
}

function parseTimeout(value: string | undefined): number {
  if (!value?.trim()) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(value);
  if (
    !Number.isInteger(parsed)
    || parsed < 10_000
    || parsed > 10 * 60_000
  ) {
    throw new Error(
      "FEISHU_PROBE_TIMEOUT_MS must be an integer between 10000 and 600000",
    );
  }
  return parsed;
}

function sanitize(value: string): string {
  return value
    .replace(/[^\x20-\x7E\u4E00-\u9FFF]/gu, "_")
    .slice(0, 240);
}
