import { join, resolve } from "node:path";
import { ManagedCodexDeepSeekRuntime } from "../src/agent/managed-codex-deepseek-runtime.js";
import { loadEnv } from "../src/config/env.js";
import { loadProjectEnv } from "../src/config/load-project-env.js";
import { GatewayService } from "../src/service/gateway.js";
import {
  FullChainObservedStore,
  FullChainObservedTransport,
} from "../src/service/full-chain-acceptance.js";
import { SqliteGatewayStore } from "../src/storage/sqlite.js";
import { QqTransport } from "../src/transport/qq/qq-transport.js";

const EXPECTED_MARKER = "FLORAL_QQ_FULL_CHAIN_OK";

loadProjectEnv();
const env = loadEnv();
requireValue(env.QQBOT_APP_ID, "QQBOT_APP_ID");
requireValue(env.QQBOT_APP_SECRET, "QQBOT_APP_SECRET");
requireValue(env.DEEPSEEK_API_KEY, "DEEPSEEK_API_KEY");
requireValue(env.OWNER_PAIRING_CODE, "OWNER_PAIRING_CODE");

const databasePath = resolve(env.DATABASE_PATH);
const rawStore = await SqliteGatewayStore.open(databasePath);
const before = rawStore.diagnostics();
if (before.owners > 1) {
  await rawStore.close();
  throw new Error(`Expected at most one owner, found ${before.owners}`);
}

const observedStore = new FullChainObservedStore(rawStore);
const qqTransport = new QqTransport({
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
const observedTransport = new FullChainObservedTransport(
  qqTransport,
  EXPECTED_MARKER,
);
const agent = new ManagedCodexDeepSeekRuntime(env);
const gateway = new GatewayService(
  observedTransport,
  agent,
  observedStore,
  {
    cwd: env.CODEX_CWD,
    model: env.DEEPSEEK_MODEL,
    ownerPairingCode: env.OWNER_PAIRING_CODE!,
    trustMockOwner: false,
  },
);

console.log("qq.full_chain.mode=real-c2c-managed-stack");
console.log(`qq.full_chain.owner_state=${before.owners === 0 ? "missing" : "existing"}`);
console.log("qq.full_chain.expected_reply=FLORAL_QQ_FULL_CHAIN_OK");
console.log("qq.full_chain.instructions=send-pair-if-needed-then-exact-probe-prompt");
console.log("qq.full_chain.prompt=只回复：FLORAL_QQ_FULL_CHAIN_OK");
console.log("qq.full_chain.waiting=true");

let started = false;
try {
  await gateway.start();
  started = true;
  console.log("qq.full_chain.gateway=ready");

  await observedTransport.waitForMarker(env.QQBOT_FULL_CHAIN_TIMEOUT_MS);
  const storeState = observedStore.snapshot();
  const transportState = observedTransport.snapshot();
  const after = rawStore.diagnostics();

  if (after.owners !== 1) {
    throw new Error(`Expected exactly one owner after acceptance, found ${after.owners}`);
  }
  if (!storeState.runRequested || !storeState.runCompleted || storeState.runFailed) {
    throw new Error("Agent run did not complete successfully");
  }
  if (!storeState.threadAfterRun) {
    throw new Error("Codex thread was not persisted");
  }
  if (!transportState.markerDelivered) {
    throw new Error("Expected QQ marker reply was not delivered");
  }

  const ownerResult = before.owners === 0
    ? (storeState.ownerPaired ? "paired" : "missing")
    : "existing";
  const threadResult = !storeState.threadBeforeRun
    ? "created"
    : storeState.threadBeforeRun === storeState.threadAfterRun
      ? "reused"
      : "recovered";

  console.log(`qq.full_chain.owner=${ownerResult}`);
  console.log("qq.full_chain.sqlite=ok");
  console.log("qq.full_chain.agent_run=completed");
  console.log(`qq.full_chain.thread=${threadResult}`);
  console.log("qq.full_chain.passive_reply=ok");
  console.log(`qq.full_chain.outbound_messages=${transportState.outboundMessages}`);
  console.log("qq.full_chain.result=ok");
} catch (error) {
  const storeState = observedStore.snapshot();
  const transportState = observedTransport.snapshot();
  console.log(`qq.full_chain.agent_requested=${storeState.runRequested}`);
  console.log(`qq.full_chain.agent_completed=${storeState.runCompleted}`);
  console.log(`qq.full_chain.agent_failed=${storeState.runFailed}`);
  console.log(`qq.full_chain.marker_delivered=${transportState.markerDelivered}`);
  console.log(`qq.full_chain.error=${safeErrorType(error)}`);
  console.log("qq.full_chain.result=failed");
  process.exitCode = 1;
} finally {
  if (started) {
    await gateway.stop();
  } else {
    await Promise.allSettled([
      observedTransport.stop(),
      agent.stop(),
      observedStore.close(),
    ]);
  }
}

function requireValue(value: string | undefined, name: string): asserts value is string {
  if (!value?.trim()) throw new Error(`${name} is required for qq:full-chain:probe`);
}

function safeErrorType(error: unknown): string {
  if (error instanceof Error && error.name.trim()) return error.name;
  return "Error";
}
