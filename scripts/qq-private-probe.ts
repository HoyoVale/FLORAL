import { join, resolve } from "node:path";
import { loadEnv } from "../src/config/env.js";
import { loadProjectEnv } from "../src/config/load-project-env.js";
import { QqTransport } from "../src/transport/qq/qq-transport.js";

loadProjectEnv();
const env = loadEnv();

if (!env.QQBOT_APP_ID || !env.QQBOT_APP_SECRET) {
  throw new Error("QQ private probe requires QQBOT_APP_ID and QQBOT_APP_SECRET");
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

const completion = deferred<void>();
let messageHandled = false;
let timer: ReturnType<typeof setTimeout> | undefined;

const stop = async () => {
  if (timer) clearTimeout(timer);
  await transport.stop();
};

process.once("SIGINT", () => {
  completion.reject(new Error("QQ private probe interrupted"));
});

try {
  console.log("qq.probe.mode=c2c-passive-reply");
  console.log("qq.probe.waiting=true");

  await transport.start(async (message) => {
    if (messageHandled) return;
    messageHandled = true;

    console.log("qq.probe.inbound=c2c");
    console.log(`qq.probe.input_characters=${message.text.length}`);

    await transport.send({
      conversationId: message.identity.conversationId,
      text: "FLORAL_QQ_TRANSPORT_OK",
    });

    console.log("qq.probe.passive_reply=ok");
    completion.resolve(undefined);
  });

  console.log("qq.probe.gateway=ready");
  timer = setTimeout(() => {
    completion.reject(new Error(
      `QQ private probe timed out after ${env.QQBOT_PROBE_TIMEOUT_MS}ms`,
    ));
  }, env.QQBOT_PROBE_TIMEOUT_MS);

  await completion.promise;
  console.log("qq.probe.result=ok");
} finally {
  await stop();
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}
