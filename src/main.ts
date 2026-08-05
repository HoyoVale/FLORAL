import { CodexAppServerRuntime } from "./agent/codex-app-server.js";
import { MockAgentRuntime } from "./agent/mock-agent.js";
import { loadEnv } from "./config/env.js";
import { loadProjectEnv } from "./config/load-project-env.js";
import type { AgentRuntime, ChatTransport } from "./core/contracts.js";
import { GatewayService } from "./service/gateway.js";
import { MemoryThreadStore } from "./storage/memory-thread-store.js";
import { MockQqTransport } from "./transport/qq/mock-qq-transport.js";
import { QqTransport } from "./transport/qq/qq-transport.js";

loadProjectEnv();
const env = loadEnv();

const transport: ChatTransport = env.QQ_MODE === "real"
  ? new QqTransport({ appId: env.QQBOT_APP_ID!, appSecret: env.QQBOT_APP_SECRET! })
  : new MockQqTransport();

const agent: AgentRuntime = env.CODEX_MODE === "real"
  ? new CodexAppServerRuntime({
      command: env.CODEX_COMMAND,
      args: env.CODEX_ARGS.split(/\s+/).filter(Boolean),
      requestTimeoutMs: env.CODEX_REQUEST_TIMEOUT_MS,
      defaultModel: env.CODEX_MODEL,
    })
  : new MockAgentRuntime();

const gateway = new GatewayService(
  transport,
  agent,
  new MemoryThreadStore(),
  { cwd: env.CODEX_CWD, ...(env.CODEX_MODEL ? { model: env.CODEX_MODEL } : {}) },
);

const shutdown = async (signal: string) => {
  process.stderr.write(`\n${signal}: stopping gateway...\n`);
  await gateway.stop();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await gateway.start();
