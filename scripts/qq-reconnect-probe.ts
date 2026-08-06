import { join, resolve } from "node:path";
import { loadEnv } from "../src/config/env.js";
import { loadProjectEnv } from "../src/config/load-project-env.js";
import { QqTransport } from "../src/transport/qq/qq-transport.js";

const REPLY = "FLORAL_QQ_RECONNECT_OK";

loadProjectEnv();
const env = loadEnv();
if (!env.QQBOT_APP_ID || !env.QQBOT_APP_SECRET) {
  throw new Error("QQBOT_APP_ID and QQBOT_APP_SECRET are required");
}

const transport = new QqTransport({
  appId: env.QQBOT_APP_ID,
  appSecret: env.QQBOT_APP_SECRET,
  dataDir: resolve(env.QQBOT_SESSION_DIR ?? join(env.DATA_DIR, "qq-session")),
  startupTimeoutMs: env.QQBOT_STARTUP_TIMEOUT_MS,
  replyTargetTtlMs: env.QQBOT_REPLY_TARGET_TTL_MS,
  replyTargetCacheEntries: env.QQBOT_REPLY_TARGET_CACHE_ENTRIES,
  textChunkCharacters: env.QQBOT_TEXT_CHUNK_CHARACTERS,
  maxReplyChunks: env.QQBOT_MAX_REPLY_CHUNKS,
  outboundTimeoutMs: env.QQBOT_OUTBOUND_TIMEOUT_MS,
});

let reconnectObserved = false;
let replyDelivered = false;
let resolveReply!: () => void;
const reply = new Promise<void>((resolvePromise) => {
  resolveReply = resolvePromise;
});

console.log("qq.reconnect.mode=network-resume");
console.log("qq.reconnect.instructions=disconnect-network-briefly-then-restore");

try {
  await transport.start(async (message) => {
    if (!reconnectObserved || replyDelivered) return;
    await transport.send({
      conversationId: message.identity.conversationId,
      text: REPLY,
    });
    replyDelivered = true;
    resolveReply();
  });
  const initial = transport.snapshot();
  console.log("qq.reconnect.gateway=ready");
  console.log("qq.reconnect.waiting_for_resume=true");

  await waitUntil(
    () => {
      const current = transport.snapshot();
      return current.resumedCount > initial.resumedCount
        || current.readyCount > initial.readyCount;
    },
    env.QQBOT_RECONNECT_PROBE_TIMEOUT_MS,
    "QQ reconnect event",
  );
  reconnectObserved = true;
  console.log("qq.reconnect.connection=restored");
  console.log("qq.reconnect.instructions=send-one-private-message-now");

  await withTimeout(
    reply,
    env.QQBOT_RECONNECT_PROBE_TIMEOUT_MS,
    "QQ post-reconnect passive reply",
  );
  console.log("qq.reconnect.passive_reply=ok");
  console.log("qq.reconnect.result=ok");
} catch (error) {
  console.log(`qq.reconnect.error=${safeErrorType(error)}`);
  console.log("qq.reconnect.result=failed");
  process.exitCode = 1;
} finally {
  await transport.stop();
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms`);
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
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function safeErrorType(error: unknown): string {
  if (error instanceof Error && error.name.trim()) return error.name;
  return "Error";
}
