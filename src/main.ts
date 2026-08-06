import { join, resolve } from "node:path";
import { ManagedCodexDeepSeekRuntime } from "./agent/managed-codex-deepseek-runtime.js";
import { MockAgentRuntime } from "./agent/mock-agent.js";
import { loadEnv } from "./config/env.js";
import { loadProjectEnv } from "./config/load-project-env.js";
import type { AgentRuntime, ChatTransport } from "./core/contracts.js";
import { acquireProcessLock } from "./runtime/process-lock.js";
import { createServiceStateWriter } from "./runtime/service-state.js";
import { GatewayService } from "./service/gateway.js";
import { SqliteGatewayStore } from "./storage/sqlite.js";
import { MockQqTransport } from "./transport/qq/mock-qq-transport.js";
import { QqTransport } from "./transport/qq/qq-transport.js";

loadProjectEnv();
const env = loadEnv();
const lock = await acquireProcessLock(resolve(env.FLORAL_INSTANCE_LOCK_PATH));
const serviceState = env.FLORAL_SERVICE_MODE === "launchagent"
  ? createServiceStateWriter(resolve(env.FLORAL_SERVICE_STATE_PATH), {
      pid: process.pid,
      instanceId: lock.instanceId,
    })
  : undefined;

await serviceState?.write("starting");

const transport: ChatTransport = env.QQ_MODE === "real"
  ? new QqTransport({
      appId: env.QQBOT_APP_ID!,
      appSecret: env.QQBOT_APP_SECRET!,
      dataDir: resolve(env.QQBOT_SESSION_DIR ?? join(env.DATA_DIR, "qq-session")),
      startupTimeoutMs: env.QQBOT_STARTUP_TIMEOUT_MS,
      replyTargetTtlMs: env.QQBOT_REPLY_TARGET_TTL_MS,
      replyTargetCacheEntries: env.QQBOT_REPLY_TARGET_CACHE_ENTRIES,
      textChunkCharacters: env.QQBOT_TEXT_CHUNK_CHARACTERS,
      maxReplyChunks: env.QQBOT_MAX_REPLY_CHUNKS,
      outboundTimeoutMs: env.QQBOT_OUTBOUND_TIMEOUT_MS,
    })
  : new MockQqTransport();

const agent: AgentRuntime = env.CODEX_MODE === "real"
  ? new ManagedCodexDeepSeekRuntime(env)
  : new MockAgentRuntime();

const store = await SqliteGatewayStore.open(resolve(env.DATABASE_PATH));
const gateway = new GatewayService(
  transport,
  agent,
  store,
  {
    cwd: env.CODEX_CWD,
    ...(env.CODEX_MODEL ? { model: env.CODEX_MODEL } : {}),
    ...(env.OWNER_PAIRING_CODE
      ? { ownerPairingCode: env.OWNER_PAIRING_CODE }
      : {}),
    trustMockOwner: env.MOCK_TRUST_OWNER,
  },
);

let shutdownPromise: Promise<void> | undefined;
const shutdown = (signal: string): Promise<void> => {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    process.stderr.write(`\n${signal}: stopping gateway...\n`);
    await serviceState?.write("stopping");
    await gateway.stop();
    await serviceState?.write("stopped");
    await lock.release();
  })();
  return shutdownPromise;
};

process.once("SIGINT", () => {
  void shutdown("SIGINT").then(() => {
    process.exitCode = 0;
  });
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM").then(() => {
    process.exitCode = 0;
  });
});
process.once("SIGHUP", () => {
  void shutdown("SIGHUP").then(() => {
    process.exitCode = 0;
  });
});

try {
  await gateway.start();
  await serviceState?.write("ready");
  if (serviceState) process.stderr.write("service.gateway=ready\n");
} catch (error) {
  await serviceState?.write(
    "failed",
    error instanceof Error && error.name ? error.name : "Error",
  );
  await lock.release();
  throw error;
}
