import { join, resolve } from "node:path";
import { ManagedCodexDeepSeekRuntime } from "./agent/managed-codex-deepseek-runtime.js";
import { MockAgentRuntime } from "./agent/mock-agent.js";
import { loadEnv } from "./config/env.js";
import { loadProjectEnv } from "./config/load-project-env.js";
import type { AgentRuntime, ChatTransport } from "./core/contracts.js";
import { GatewayService } from "./service/gateway.js";
import { SqliteGatewayStore } from "./storage/sqlite.js";
import { MockQqTransport } from "./transport/qq/mock-qq-transport.js";
import { QqTransport } from "./transport/qq/qq-transport.js";

loadProjectEnv();
const env = loadEnv();

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

const shutdown = async (signal: string) => {
  process.stderr.write(`\n${signal}: stopping gateway...\n`);
  await gateway.stop();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await gateway.start();
