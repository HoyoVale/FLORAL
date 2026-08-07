import { randomBytes } from "node:crypto";
import * as Lark from "@larksuiteoapi/node-sdk";
import type { InteractiveApprovalPrompt } from "../src/core/contracts.js";
import {
  buildFeishuApprovalCard,
  normalizeFeishuApprovalCardAction,
  type FeishuCardActionEvent,
} from "../src/transport/feishu/feishu-card.js";
import {
  normalizeFeishuMessageEvent,
  type FeishuMessageEvent,
} from "../src/transport/feishu/feishu-message.js";
import { loadProjectEnv } from "../src/config/load-project-env.js";

const DEFAULT_TIMEOUT_MS = 120_000;

loadProjectEnv();

const appId = requireSecret("FEISHU_APP_ID");
const appSecret = requireSecret("FEISHU_APP_SECRET");
const timeoutMs = parseTimeout(process.env.FEISHU_PROBE_TIMEOUT_MS);
const approvalId = `CARD${randomBytes(5).toString("hex").toUpperCase()}`;

const client = new Lark.Client({
  appId,
  appSecret,
});

const wsClient = new Lark.WSClient({
  appId,
  appSecret,
  loggerLevel: Lark.LoggerLevel.info,
});

let route:
  | {
      conversationId: string;
      externalUserId: string;
    }
  | undefined;
let settled = false;

const completion = new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => {
    reject(new Error(`Feishu card probe timed out after ${timeoutMs}ms`));
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
      if (route) return {};
      const normalized = normalizeFeishuMessageEvent(
        data as FeishuMessageEvent,
        appId,
      );
      if (!normalized) return {};

      const prompt: InteractiveApprovalPrompt = {
        conversationId: normalized.identity.conversationId,
        approvalId,
        capability: "files.write",
        summary: "Phase 5F.3A native Feishu approval card probe",
        ttlMs: timeoutMs,
      };

      try {
        await client.im.v1.message.create({
          params: {
            receive_id_type: "chat_id",
          },
          data: {
            receive_id: normalized.identity.conversationId,
            msg_type: "interactive",
            content: JSON.stringify(buildFeishuApprovalCard(prompt)),
          },
        });
        route = {
          conversationId: normalized.identity.conversationId,
          externalUserId: normalized.identity.externalUserId,
        };
        console.log("feishu.card_probe.card=sent");
        console.log("feishu.card_probe.buttons=allow-once,deny");
        console.log("feishu.card_probe.waiting_for_callback=true");
      } catch (error) {
        finish(error);
      }
      return {};
    },

    "card.action.trigger": async (data: unknown) => {
      const action = normalizeFeishuApprovalCardAction(
        data as FeishuCardActionEvent,
        appId,
      );
      if (!action) {
        console.log("feishu.card_probe.callback=ignored-invalid");
        return toast("warning", "无法识别该卡片操作");
      }

      const current = route;
      if (!current) {
        console.log("feishu.card_probe.callback=ignored-no-route");
        return toast("warning", "当前没有待测试的审批卡片");
      }
      if (
        action.conversationId !== current.conversationId
        || action.externalUserId !== current.externalUserId
        || action.approvalId !== approvalId
      ) {
        console.log("feishu.card_probe.callback=ignored-scope-mismatch");
        return toast("error", "卡片操作与当前测试会话不匹配");
      }

      console.log("feishu.card_probe.callback=received");
      console.log(`feishu.card_probe.decision=${action.decision}`);
      console.log("feishu.card_probe.operator_open_id=match");
      console.log("feishu.card_probe.chat_id=match");
      console.log("feishu.card_probe.approval_id=match");
      finish();

      // Long-connection callbacks must be answered quickly. This response is
      // intentionally only a UI acknowledgement; production authorization is
      // not exercised by this direct probe.
      return toast(
        "success",
        action.decision === "approve"
          ? "已收到“允许一次”测试操作"
          : "已收到“拒绝”测试操作",
      );
    },
  });

  try {
    console.log("feishu.card_probe.mode=direct-sdk-long-connection");
    console.log("feishu.card_probe.gateway=bypassed");
    console.log("feishu.card_probe.authorization=bypassed");
    console.log("feishu.card_probe.card_schema=2.0");
    console.log("feishu.card_probe.callback=card.action.trigger");
    console.log("feishu.card_probe.instructions=send-one-private-text-message-then-click-a-card-button");
    wsClient.start({ eventDispatcher });
  } catch (error) {
    finish(error);
  }
});

try {
  await completion;
  console.log("feishu.card_probe.result=ok");
  setTimeout(() => process.exit(0), 50);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`feishu.card_probe.result=error:${sanitize(message)}`);
  setTimeout(() => process.exit(1), 50);
}

function toast(
  type: "success" | "error" | "warning",
  content: string,
): Record<string, unknown> {
  return {
    toast: {
      type,
      content,
    },
  };
}

function requireSecret(name: "FEISHU_APP_ID" | "FEISHU_APP_SECRET"): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the Feishu card probe`);
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
