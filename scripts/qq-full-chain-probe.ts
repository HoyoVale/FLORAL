import { resolve } from "node:path";
import type { AppEnv } from "../src/config/env.js";
import { ManagedCodexDeepSeekRuntime } from "../src/agent/managed-codex-deepseek-runtime.js";
import { loadEnv } from "../src/config/env.js";
import { resolveConfigurationAuthority } from "../src/config/federation/config-authority.js";
import { loadProjectEnv } from "../src/config/load-project-env.js";
import { GatewayService } from "../src/service/gateway.js";
import {
  acquireProbeStackGuard,
  ProbeStackBusyError,
  type ProbeStackGuard,
} from "../src/service/probe-stack-guard.js";
import {
  FullChainObservedStore,
  FullChainObservedTransport,
} from "../src/service/full-chain-acceptance.js";
import { SqliteGatewayStore } from "../src/storage/sqlite.js";
import { createUnifiedQqTransportForProbe } from "../src/transport/qq/qq-runtime-adoption-transport.js";

const EXPECTED_MARKER = "FLORAL_QQ_FULL_CHAIN_OK";

loadProjectEnv();
const env = loadEnv();
await runProbe(env);

async function runProbe(env: AppEnv): Promise<void> {
  requireValue(env.QQBOT_APP_ID, "QQBOT_APP_ID");
  requireValue(env.QQBOT_APP_SECRET, "QQBOT_APP_SECRET");
  requireValue(env.DEEPSEEK_API_KEY, "DEEPSEEK_API_KEY");
  requireValue(env.OWNER_PAIRING_CODE, "OWNER_PAIRING_CODE");

  let guard: ProbeStackGuard;
  try {
    guard = await acquireProbeStackGuard(env.FLORAL_INSTANCE_LOCK_PATH);
  } catch (error) {
    if (error instanceof ProbeStackBusyError) {
      console.log("qq.full_chain.mode=real-c2c-managed-stack");
      console.log(`qq.full_chain.blocked_pid=${String(error.pid)}`);
      console.log("qq.full_chain.blocked_reason=floral-stack-already-running");
      console.log("qq.full_chain.instructions=run-service-stop-before-probe");
      console.log("qq.full_chain.result=blocked");
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
  const databasePath = resolve(env.DATABASE_PATH);
  const rawStore = await SqliteGatewayStore.open(databasePath);
  const before = rawStore.diagnostics();
  if (before.owners > 1) {
    await rawStore.close();
    throw new Error(`Expected at most one owner, found ${before.owners}`);
  }

  const observedStore = new FullChainObservedStore(rawStore);
  const qqTransport = createUnifiedQqTransportForProbe({
    repositoryRoot: process.cwd(),
    authority: await resolveConfigurationAuthority({
      repositoryRoot: process.cwd(),
      environment: process.env,
    }),
    environment: process.env,
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
  console.log("qq.full_chain.exclusive_lock=ok");
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
}

function requireValue(value: string | undefined, name: string): asserts value is string {
  if (!value?.trim()) throw new Error(`${name} is required for qq:full-chain:probe`);
}

function safeErrorType(error: unknown): string {
  if (error instanceof Error && error.name.trim()) return error.name;
  return "Error";
}
