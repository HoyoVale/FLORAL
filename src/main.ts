import { homedir } from "node:os";
import { resolve } from "node:path";
import { ManagedCodexDeepSeekRuntime } from "./agent/managed-codex-deepseek-runtime.js";
import { MockAgentRuntime } from "./agent/mock-agent.js";
import { loadEnv } from "./config/env.js";
import { resolveConfigurationAuthority } from "./config/federation/config-authority.js";
import { loadProjectEnv } from "./config/load-project-env.js";
import { buildMcpRuntimeRegistry } from "./config/mcp/mcp-runtime-registry.js";
import type { AgentRuntime, ChatTransport } from "./core/contracts.js";
import { acquireProcessLock } from "./runtime/process-lock.js";
import { createServiceStateWriter } from "./runtime/service-state.js";
import { readDeepSeekCostGuardSnapshot } from "./runtime/cost/deepseek-cost-guard.js";
import { AuthorizationAuthority } from "./policy/authorization-authority.js";
import { LocalConfirmationBroker } from "./policy/local-confirmation-broker.js";
import { resolveLocalConfirmationDirectory } from "./policy/local-confirmation-paths.js";
import { GatewayService } from "./service/gateway.js";
import { SqliteGatewayStore } from "./storage/sqlite.js";
import { MockQqTransport } from "./transport/qq/mock-qq-transport.js";
import { QqRuntimeAdoptionTransport } from "./transport/qq/qq-runtime-adoption-transport.js";

loadProjectEnv();
const env = loadEnv();
const repositoryRoot = process.cwd();
const authority = await resolveConfigurationAuthority({
  repositoryRoot,
  environment: process.env,
});
const lock = await acquireProcessLock(resolve(env.FLORAL_INSTANCE_LOCK_PATH));
const serviceState = env.FLORAL_SERVICE_MODE === "launchagent"
  ? createServiceStateWriter(resolve(env.FLORAL_SERVICE_STATE_PATH), {
      pid: process.pid,
      instanceId: lock.instanceId,
    })
  : undefined;

await serviceState?.write("starting");

const transport: ChatTransport = env.QQ_MODE === "real"
  ? new QqRuntimeAdoptionTransport(
      repositoryRoot,
      authority,
      env,
      process.env,
    )
  : new MockQqTransport();

const agent: AgentRuntime = env.CODEX_MODE === "real"
  ? new ManagedCodexDeepSeekRuntime(env, {}, {
      codexTurnApprovalPolicy: authority.effective.runtime.authorization.codex_turn_approval_policy,
      codexSandboxMode: "read-only",
    })
  : new MockAgentRuntime();

const store = await SqliteGatewayStore.open(resolve(env.DATABASE_PATH));
const authorizationAuthority = new AuthorizationAuthority({
  enabled: authority.effective.runtime.authorization.enabled,
  sandboxMode: authority.effective.codex.sandbox.mode,
  allowRemoteFileChangeApproval: authority.effective.runtime.authorization.allow_remote_file_change_approval,
  mcpRegistry: buildMcpRuntimeRegistry(authority.effective),
});
const localConfirmation = new LocalConfirmationBroker({
  directory: resolveLocalConfirmationDirectory(homedir()),
  ttlMs: authority.effective.runtime.authorization.local_approval_ttl_ms,
  pollIntervalMs: authority.effective.runtime.authorization.local_approval_poll_ms,
  maxPending: authority.effective.runtime.authorization.max_pending_approvals,
  enabled: authority.effective.runtime.authorization.local_confirmation_enabled && process.platform === "darwin",
});
await localConfirmation.initialize();
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
    authorization: {
      authority: authorizationAuthority,
      approvalTtlMs: authority.effective.runtime.authorization.approval_ttl_ms,
      maxPendingApprovals: authority.effective.runtime.authorization.max_pending_approvals,
      ownerOnlyRemoteApproval: authority.effective.runtime.authorization.owner_only_remote_approval,
      localConfirmation,
    },
    runtimeStatusLines: async () => {
      const snapshot = await readDeepSeekCostGuardSnapshot(
        repositoryRoot,
        authority.effective.runtime.cost_guard,
      );
      return [
        `cost_guard=${snapshot.blockedReason ? `blocked:${snapshot.blockedReason}` : "ready"}`,
        `cost_24h=¥${snapshot.estimatedCostCny.day.toFixed(3)}/${authority.effective.runtime.cost_guard.max_cost_cny_per_day.toFixed(2)}`,
        `tokens_24h=${String(snapshot.tokens.day)}/${String(authority.effective.runtime.cost_guard.max_tokens_per_day)}`,
        `requests_hour=${String(snapshot.requests.hour)}/${String(authority.effective.runtime.cost_guard.max_requests_per_hour)}`,
      ];
    },
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
