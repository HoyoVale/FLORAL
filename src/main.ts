import { homedir } from "node:os";
import { resolve } from "node:path";
import { ManagedCodexDeepSeekRuntime } from "./agent/managed-codex-deepseek-runtime.js";
import {
  readCodexNativeMemoryPhase2Diagnostics,
  renderCodexNativeMemoryPhase2DiagnosticLines,
} from "./agent/codex-native-memory-diagnostics.js";
import {
  readCodexNativeMemoryRuntimeStatus,
  renderCodexNativeMemoryRuntimeLines,
} from "./agent/codex-native-memory-status.js";
import { MockAgentRuntime } from "./agent/mock-agent.js";
import { loadEnv } from "./config/env.js";
import {
  resolveConfigurationAuthority,
  resolveEffectiveChatTransport,
} from "./config/federation/config-authority.js";
import { loadProjectEnv } from "./config/load-project-env.js";
import { buildMcpRuntimeRegistry } from "./config/mcp/mcp-runtime-registry.js";
import {
  buildFeishuRuntimeOptionsContract,
  resolveFeishuRuntimeCredentials,
} from "./config/feishu/feishu-runtime-options.js";
import {
  supportsAgentProjectRuntimeStorage,
  type AgentRuntime,
  type ChatTransport,
} from "./core/contracts.js";
import { acquireProcessLock } from "./runtime/process-lock.js";
import { createServiceStateWriter } from "./runtime/service-state.js";
import { readDeepSeekCostGuardSnapshot } from "./runtime/cost/deepseek-cost-guard.js";
import { AuthorizationAuthority } from "./policy/authorization-authority.js";
import { ArtifactEgressPolicy } from "./policy/artifact-egress-policy.js";
import { LocalConfirmationBroker } from "./policy/local-confirmation-broker.js";
import { resolveLocalConfirmationDirectory } from "./policy/local-confirmation-paths.js";
import { GatewayService } from "./service/gateway.js";
import { createDefaultSystemAwarenessReader } from "./system-awareness/index.js";
import { SqliteGatewayStore } from "./storage/sqlite.js";
import { FeishuTransport } from "./transport/feishu/feishu-transport.js";
import { MockQqTransport } from "./transport/qq/mock-qq-transport.js";
import { QqRuntimeAdoptionTransport } from "./transport/qq/qq-runtime-adoption-transport.js";
import { ProjectWorkspaceRoot } from "./workspace/project-workspace.js";
import {
  SystemMaintenanceController,
  resolveSystemMaintenanceDirectory,
} from "./system-maintenance/system-maintenance.js";
import { MaintenanceAutonomySupervisor } from "./system-maintenance/maintenance-autonomy-supervisor.js";

loadProjectEnv();
const env = loadEnv();
const repositoryRoot = process.cwd();
const projectWorkspace = env.FLORAL_WORKSPACE_ROOT
  ? new ProjectWorkspaceRoot(env.FLORAL_WORKSPACE_ROOT)
  : undefined;
await projectWorkspace?.initialize();

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

const chatTransport = resolveEffectiveChatTransport(authority.effective);
const transport: ChatTransport = createChatTransport(chatTransport);

const agent: AgentRuntime = env.CODEX_MODE === "real"
  ? new ManagedCodexDeepSeekRuntime(env, {}, {
      codexTurnApprovalPolicy: authority.effective.runtime.authorization.codex_turn_approval_policy,
      codexSandboxMode: authority.effective.runtime.authorization.codex_turn_sandbox_mode,
      codexApprovalsReviewer: authority.effective.runtime.authorization.codex_approvals_reviewer,
      systemAwareness: {
        repositoryRoot,
        authority,
        environment: process.env,
      },
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

const artifactEgressPolicy = new ArtifactEgressPolicy({
  enabled: chatTransport === "feishu",
  allowedRoots: [
    resolve(env.CODEX_CWD, "artifacts", "outbound"),
    ...(projectWorkspace ? [projectWorkspace.root] : []),
  ],
  allowedMcpProducers: [
    ...authority.effective.mcp.macos.enabled_tools
      .filter((toolName) => toolName === "image" || toolName === "see")
      .map((toolName) => `${authority.effective.mcp.macos.id}/${toolName}`),
    ...authority.effective.mcp.vision.enabled_tools.map((toolName) =>
      `${authority.effective.mcp.vision.id}/${toolName}`
    ),
  ],
  // Host-side generic delivery may register only files staged under the
  // outbound DLP root. ArtifactEgressPolicy still validates the canonical path,
  // provenance, role, size budget, and message.send permission before egress.
  allowedFloralCapabilities: ["files.read"],
  maxArtifactsPerRun: 4,
  maxBytesPerRun: 25_000_000,
});
await artifactEgressPolicy.initialize();

const systemAwareness = createDefaultSystemAwarenessReader({
  repositoryRoot,
  authority,
  env,
  runtime: agent,
  environment: process.env,
});

const systemMaintenance = serviceState
  ? new SystemMaintenanceController({
      directory: resolveSystemMaintenanceDirectory(
        repositoryRoot,
        authority.effective.floral.data_dir,
      ),
      serviceStatePath: resolve(repositoryRoot, env.FLORAL_SERVICE_STATE_PATH),
      workerPath: resolve(repositoryRoot, "dist", "src", "system-maintenance", "service-restart-worker.js"),
      autonomy: {
        ceiling: env.FLORAL_MAINTENANCE_MODE_CEILING,
        allowedActions: ["floral.service.restart"],
        maxAutomaticActionsPerHour: env.FLORAL_MAINTENANCE_MAX_ACTIONS_PER_HOUR,
        cooldownMs: env.FLORAL_MAINTENANCE_COOLDOWN_MS,
        failureThreshold: env.FLORAL_MAINTENANCE_FAILURE_THRESHOLD,
        selfHealIntervalMs: env.FLORAL_MAINTENANCE_SELF_HEAL_INTERVAL_MS,
      },
    })
  : undefined;
await systemMaintenance?.initialize();

const runtimeManagedHomeForCwd = async (cwd: string): Promise<string> => {
  if (supportsAgentProjectRuntimeStorage(agent)) {
    return await agent.resolveRuntimeHome({ cwd });
  }
  return resolve(repositoryRoot, authority.effective.codex.managed_home);
};

const gateway = new GatewayService(
  transport,
  agent,
  store,
  {
    cwd: env.CODEX_CWD,
    ...(projectWorkspace ? { workspace: projectWorkspace } : {}),
    ...(env.CODEX_MODEL ? { model: env.CODEX_MODEL } : {}),
    ...(env.OWNER_PAIRING_CODE
      ? { ownerPairingCode: env.OWNER_PAIRING_CODE }
      : {}),
    trustMockOwner: env.MOCK_TRUST_OWNER,
    conversationUx: chatTransport === "mock"
      ? { visibleActivityFallback: false, visibleActivityDelayMs: 6_000 }
      : chatTransport === "feishu"
        ? {
            visibleActivityFallback:
              authority.effective.feishu.presentation.visible_activity_fallback,
            visibleActivityDelayMs:
              authority.effective.feishu.presentation.visible_activity_delay_ms,
          }
        : {
            visibleActivityFallback:
              authority.effective.qq.presentation.visible_activity_fallback,
            visibleActivityDelayMs:
              authority.effective.qq.presentation.visible_activity_delay_ms,
          },
    authorization: {
      authority: authorizationAuthority,
      approvalTtlMs: authority.effective.runtime.authorization.approval_ttl_ms,
      maxPendingApprovals: authority.effective.runtime.authorization.max_pending_approvals,
      ownerOnlyRemoteApproval: authority.effective.runtime.authorization.owner_only_remote_approval,
      remoteModeCeiling: env.FLORAL_REMOTE_MODE_CEILING,
      localConfirmation,
    },
    artifactEgress: {
      policy: artifactEgressPolicy,
    },
    systemAwareness,
    ...(systemMaintenance ? { systemMaintenance: { controller: systemMaintenance } } : {}),
    runtimeStatusLines: async (cwd) => {
      const managedHome = await runtimeManagedHomeForCwd(cwd);
      const [snapshot, nativeMemory] = await Promise.all([
        readDeepSeekCostGuardSnapshot(
          repositoryRoot,
          authority.effective.runtime.cost_guard,
        ),
        readCodexNativeMemoryRuntimeStatus({
          repositoryRoot,
          managedHome,
          config: authority.effective.codex.memories,
        }),
      ]);
      const maintenancePolicy = await systemMaintenance?.autonomyStatus().catch(() => undefined);
      return [
        ...renderCodexNativeMemoryRuntimeLines(nativeMemory),
        `cost_guard=${snapshot.blockedReason ? `blocked:${snapshot.blockedReason}` : "ready"}`,
        `cost_24h=¥${snapshot.estimatedCostCny.day.toFixed(3)}/${authority.effective.runtime.cost_guard.max_cost_cny_per_day.toFixed(2)}`,
        `tokens_24h=${String(snapshot.tokens.day)}/${String(authority.effective.runtime.cost_guard.max_tokens_per_day)}`,
        `requests_hour=${String(snapshot.requests.hour)}/${String(authority.effective.runtime.cost_guard.max_requests_per_hour)}`,
        ...(maintenancePolicy ? [
          `maintenance_mode=${maintenancePolicy.effectiveMode}`,
          `maintenance_ceiling=${maintenancePolicy.ceiling}`,
          `maintenance_breaker=${maintenancePolicy.circuitBreakerOpen ? "open" : "closed"}`,
        ] : []),
      ];
    },
    nativeMemoryDiagnosticLines: async (cwd) => {
      const managedHome = await runtimeManagedHomeForCwd(cwd);
      const nativeMemory = await readCodexNativeMemoryRuntimeStatus({
        repositoryRoot,
        managedHome,
        config: authority.effective.codex.memories,
      });
      const diagnostics = await readCodexNativeMemoryPhase2Diagnostics({
        managedHome,
        runtime: nativeMemory,
      });
      return [
        ...renderCodexNativeMemoryRuntimeLines(nativeMemory),
        ...renderCodexNativeMemoryPhase2DiagnosticLines(diagnostics),
      ];
    },
  },
);

const maintenanceAutonomy = systemMaintenance
  ? new MaintenanceAutonomySupervisor({
      controller: systemMaintenance,
      systemAwareness,
      cwd: env.CODEX_CWD,
      store,
      notify: async (conversationId, text) => {
        await transport.send({ conversationId, text });
      },
    })
  : undefined;

function createChatTransport(
  selection: "mock" | "qq" | "feishu",
): ChatTransport {
  if (selection === "mock") return new MockQqTransport();
  if (selection === "qq") {
    return new QqRuntimeAdoptionTransport(
      repositoryRoot,
      authority,
      env,
      process.env,
    );
  }

  const contract = buildFeishuRuntimeOptionsContract(authority.effective);
  const credentials = resolveFeishuRuntimeCredentials(authority, process.env);
  return new FeishuTransport({
    appId: credentials.appId,
    appSecret: credentials.appSecret,
    expectedSdkVersion: contract.expectedVersion,
    startupTimeoutMs: contract.delivery.startupTimeoutMs,
    outboundTimeoutMs: contract.delivery.outboundTimeoutMs,
    textChunkBytes: contract.delivery.textChunkBytes,
    maxReplyChunks: contract.delivery.maxReplyChunks,
    inboundRoot: resolve(repositoryRoot, env.DATA_DIR, "inbound", "feishu"),
    projectInboundRoot: resolve(repositoryRoot, env.DATA_DIR, "projects"),
    inboundMaxFileBytes: 30 * 1024 * 1024,
    inboundMaxAttachments: 8,
    inboundTimeoutMs: 120_000,
    onFatal: () => {
      // A dead long-connection worker makes the chat ingress unavailable. Re-enter
      // the normal SIGTERM shutdown path so LaunchAgent can restart the process.
      queueMicrotask(() => {
        if (!shutdownPromise) process.kill(process.pid, "SIGTERM");
      });
    },
  });
}

let shutdownPromise: Promise<void> | undefined;
const shutdown = (signal: string): Promise<void> => {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    process.stderr.write(`\n${signal}: stopping gateway...\n`);
    await serviceState?.write("stopping");
    maintenanceAutonomy?.stop();
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
  maintenanceAutonomy?.start();
} catch (error) {
  await serviceState?.write(
    "failed",
    error instanceof Error && error.name ? error.name : "Error",
  );
  await lock.release();
  throw error;
}
