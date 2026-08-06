import { join, resolve } from "node:path";
import type { AppEnv } from "../src/config/env.js";
import { loadEnv } from "../src/config/env.js";
import { loadProjectEnv } from "../src/config/load-project-env.js";
import {
  acquireProbeStackGuard,
  ProbeStackBusyError,
  type ProbeStackGuard,
} from "../src/service/probe-stack-guard.js";
import { QqTransport } from "../src/transport/qq/qq-transport.js";

const REPLY = "FLORAL_QQ_RECONNECT_OK";

loadProjectEnv();
const env = loadEnv();
await runProbe(env);

async function runProbe(env: AppEnv): Promise<void> {
  if (!env.QQBOT_APP_ID || !env.QQBOT_APP_SECRET) {
    throw new Error("QQBOT_APP_ID and QQBOT_APP_SECRET are required");
  }

  let guard: ProbeStackGuard;
  try {
    guard = await acquireProbeStackGuard(env.FLORAL_INSTANCE_LOCK_PATH);
  } catch (error) {
    if (error instanceof ProbeStackBusyError) {
      console.log("qq.reconnect.mode=network-resume");
      console.log(`qq.reconnect.blocked_pid=${String(error.pid)}`);
      console.log("qq.reconnect.blocked_reason=floral-stack-already-running");
      console.log("qq.reconnect.instructions=run-service-stop-before-probe");
      console.log("qq.reconnect.result=blocked");
      process.exitCode = 2;
      return;
    }
    throw error;
  }

  try {
    await runExclusiveProbe(env);
  } finally {
    await guard.release();
  }
}

async function runExclusiveProbe(env: AppEnv): Promise<void> {
  const transport = new QqTransport({
    appId: env.QQBOT_APP_ID!,
    appSecret: env.QQBOT_APP_SECRET!,
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
  console.log("qq.reconnect.exclusive_lock=ok");
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
