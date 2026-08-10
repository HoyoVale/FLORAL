import { randomBytes } from "node:crypto";
import { chmod, mkdir, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import {
  createCodexCutoverReport,
  removeCodexCutoverReport,
  writeCodexCutoverReport,
  type CodexCutoverReport,
} from "../config/adoption/codex-controlled-cutover.js";
import {
  prepareCodexConfigAdoption,
  removeCodexShadowReport,
  type CodexConfigAdoptionResult,
} from "../config/adoption/codex-shadow-adoption.js";
import {
  createMcpRegistryAdoptionReport,
  removeMcpRegistryAdoptionReport,
  writeMcpRegistryAdoptionReport,
  type McpRegistryAdoptionReport,
} from "../config/adoption/mcp-registry-adoption.js";
import type { AppEnv } from "../config/env.js";
import type { ResolvedConfigurationAuthority } from "../config/federation/config-authority.js";
import {
  supportsAgentExtensionControl,
  supportsAgentExtensionDiscovery,
  supportsAgentSkillControl,
  supportsAgentSkills,
  supportsAgentThreadManagement,
  type AgentAppReadResult,
  type AgentAppSummary,
  type AgentMcpServerSummary,
  type AgentNativeFeatureSummary,
  type AgentRuntime,
  type AgentSkillSummary,
  type AgentThreadSummary,
} from "../core/contracts.js";
import type {
  AgentEvent,
  AgentRunRequest,
  AgentRunResult,
} from "../core/types.js";
import { checkSearxng } from "../search/searxng.js";
import { createProjectDeepSeekCostGuard } from "../runtime/cost/cost-guard-factory.js";
import { ProviderActivityGate } from "../runtime/cost/provider-activity-gate.js";
import { createResponsesBridge } from "./bridge/bridge-factory.js";
import {
  codexModelCatalogFingerprint,
  renderCodexModelCatalog,
} from "../config/codex/codex-model-catalog.js";
import { CodexAppServerRuntime } from "./codex-app-server.js";
import { buildCodexDeepSeekConfig } from "./codex-deepseek-config.js";
import { projectRuntimeNamespace } from "../workspace/project-workspace.js";
import {
  resolveEnabledExternalSkillRoots,
  resolveExternalSkillRegistryPaths,
} from "../skills/external-skill-registry.js";
import {
  ExternalSkillManager,
  type ExternalSkillManagementResult,
  type ExternalSkillMutationRequest,
} from "../skills/external-skill-manager.js";
import {
  CURATED_EXTERNAL_MCP,
  EXTERNAL_MCP_REGISTRY_VERSION,
  externalMcpRegistryFingerprint,
  renderExternalMcpOverlay,
  type ExternalMcpRegistry,
} from "../extensions/external-mcp-registry.js";
import {
  ExternalMcpHostManager,
  type ExternalMcpManagementResult,
  type ExternalMcpMutationRequest,
} from "../extensions/external-mcp-manager.js";
import {
  ExtensionControlLedger,
  resolveExtensionControlDirectory,
  type ExtensionVerificationResult,
} from "../extensions/extension-control.js";
import {
  createDefaultSystemAwarenessReader,
  createDefaultSystemDefinitionRegistry,
  type SystemAwarenessReader,
  type SystemObservationContext,
} from "../system-awareness/index.js";
import {
  FLORAL_PROJECT_PERMISSION_PROFILE,
  createPersistentCodexWorkspace,
  scopeCodexConfigForProject,
  uniqueAbsolutePaths,
  type ManagedWorkspace,
  type ProjectRuntimeScope,
} from "./managed-codex-workspace.js";

export { createPersistentCodexWorkspace } from "./managed-codex-workspace.js";
export type { ManagedWorkspace } from "./managed-codex-workspace.js";

interface ManagedBridge {
  start(): Promise<{ baseUrl: string }>;
  stop(): Promise<void>;
}

interface SearchEndpoint {
  endpoint: string;
  resultCount: number;
}

interface ManagedRuntimeSlot {
  key: string;
  runtime: AgentRuntime;
  workspace: ManagedWorkspace;
  codexHome: string;
  scope?: ProjectRuntimeScope | undefined;
}

export interface ManagedCodexDeepSeekDependencies {
  createToken?: (() => string) | undefined;
  checkSearch?: (() => Promise<SearchEndpoint>) | undefined;
  createBridge?: ((token: string) => ManagedBridge) | undefined;
  createWorkspace?: ((
    config: string,
    codexHome: string,
    options?: {
      fallbackConfig?: string | undefined;
      modelCatalog?: string | undefined;
    },
  ) => Promise<ManagedWorkspace>) | undefined;
  createRuntime?: ((options: {
    codexHome: string;
    bridgeToken: string;
    approvalPolicy: "never" | "on-request" | "untrusted";
    sandboxMode: "read-only" | "workspace-write";
    approvalsReviewer: "user";
    skillRoots: string[];
    protectedSkillRoots: string[];
    externalSkillCatalog: () => Promise<string>;
    manageExternalSkill: (
      request: ExternalSkillMutationRequest,
    ) => Promise<ExternalSkillManagementResult>;
    externalMcpCatalog: () => Promise<string>;
    manageExternalMcp: (
      request: ExternalMcpMutationRequest,
    ) => Promise<ExternalMcpManagementResult>;
    recordAppInstallHandoff: (appId: string) => Promise<{ transactionId: string }>;
    recordExtensionVerification: (result: ExtensionVerificationResult) => Promise<void>;
    permissionProfile?: string | undefined;
    permissionProfileCwd?: string | undefined;
  }) => AgentRuntime) | undefined;
  resolveExternalSkillRoots?: (() => Promise<string[]>) | undefined;
  externalSkillCatalog?: (() => Promise<string>) | undefined;
  manageExternalSkill?: ((
    request: ExternalSkillMutationRequest,
  ) => Promise<ExternalSkillManagementResult>) | undefined;
  externalMcpCatalog?: (() => Promise<string>) | undefined;
  readExternalMcpRegistry?: (() => Promise<ExternalMcpRegistry>) | undefined;
  manageExternalMcp?: ((
    request: ExternalMcpMutationRequest,
  ) => Promise<ExternalMcpManagementResult>) | undefined;
  prepareCodexConfig?: ((options: {
    legacyConfig: string;
    bridgeBaseUrl: string;
  }) => Promise<CodexConfigAdoptionResult>) | undefined;
  clearCodexShadowReport?: (() => Promise<void>) | undefined;
  clearCodexCutoverReport?: (() => Promise<void>) | undefined;
  recordCodexCutover?: ((report: CodexCutoverReport) => Promise<string>) | undefined;
  clearMcpRegistryAdoptionReport?: (() => Promise<void>) | undefined;
  recordMcpRegistryAdoption?: ((report: McpRegistryAdoptionReport) => Promise<string>) | undefined;
}

export interface ManagedSystemAwarenessOptions {
  repositoryRoot: string;
  authority: ResolvedConfigurationAuthority;
  environment?: NodeJS.ProcessEnv | undefined;
}

export interface ManagedCodexDeepSeekRuntimeOptions {
  codexTurnApprovalPolicy?: "never" | "on-request" | "untrusted" | undefined;
  codexSandboxMode?: "read-only" | "workspace-write" | undefined;
  codexApprovalsReviewer?: "user" | undefined;
  systemAwareness?: ManagedSystemAwarenessOptions | undefined;
}

export class ManagedCodexDeepSeekRuntime implements AgentRuntime {
  readonly name = "codex-deepseek-managed";
  #runtime: AgentRuntime | undefined;
  #bridge: ManagedBridge | undefined;
  #workspace: ManagedWorkspace | undefined;
  readonly #projectRuntimes = new Map<string, ManagedRuntimeSlot>();
  readonly #projectRuntimeStarting = new Map<string, Promise<ManagedRuntimeSlot>>();
  readonly #threadRuntimeKeys = new Map<string, string>();
  readonly #providerActivityGate = new ProviderActivityGate();
  #starting: Promise<void> | undefined;
  #activeRuntimeConfig: string | undefined;
  #activeModelCatalog: string | undefined;
  #bridgeToken: string | undefined;
  #canonicalWorkspaceRoot: string | undefined;
  #sharedSkillRoots: string[] = [];
  #externalSkillManager: ExternalSkillManager | undefined;
  #externalSkillMutationTail: Promise<void> = Promise.resolve();
  #externalMcpManager: ExternalMcpHostManager | undefined;
  #externalMcpRegistry: ExternalMcpRegistry = {
    version: EXTERNAL_MCP_REGISTRY_VERSION,
    packages: [],
  };
  #externalMcpMutationTail: Promise<void> = Promise.resolve();
  #extensionControlLedger: ExtensionControlLedger | undefined;
  #stopped = false;

  constructor(
    private readonly env: AppEnv,
    private readonly dependencies: ManagedCodexDeepSeekDependencies = {},
    private readonly options: ManagedCodexDeepSeekRuntimeOptions = {},
  ) {}

  async start(): Promise<void> {
    if (this.#runtime) return;
    if (this.#stopped) {
      throw new Error("Managed Codex runtime cannot restart after stop");
    }
    if (this.#starting) return await this.#starting;

    this.#starting = this.#startOnce();
    try {
      await this.#starting;
    } finally {
      this.#starting = undefined;
    }
  }

  async run(
    request: AgentRunRequest,
    onEvent?: (event: AgentEvent) => void,
  ): Promise<AgentRunResult> {
    const slot = await this.#runtimeSlotForCwd(request.cwd);
    if (request.threadId) this.#threadRuntimeKeys.set(request.threadId, slot.key);
    const releaseProviderActivity = this.#providerActivityGate.enterAgentRun();
    try {
      const result = await slot.runtime.run(request, (event) => {
        if (event.type === "run.started") {
          this.#threadRuntimeKeys.set(event.threadId, slot.key);
        }
        onEvent?.(event);
      });
      this.#threadRuntimeKeys.set(result.threadId, slot.key);
      return result;
    } finally {
      releaseProviderActivity();
    }
  }

  async interrupt(threadId: string, turnId?: string): Promise<void> {
    const runtime = this.#runtimeForThread(threadId);
    await runtime.interrupt(threadId, turnId);
  }

  async listSkills(input: {
    cwd: string;
    forceReload?: boolean | undefined;
  }): Promise<AgentSkillSummary[]> {
    const runtime = (await this.#runtimeSlotForCwd(input.cwd)).runtime;
    if (!supportsAgentSkills(runtime)) {
      throw new Error("Managed Codex runtime does not expose skill discovery");
    }
    return await runtime.listSkills(input);
  }

  async listInstalledApps(input: {
    cwd: string;
    threadId?: string | undefined;
    forceRefresh?: boolean | undefined;
  }): Promise<AgentAppSummary[]> {
    const slot = await this.#runtimeSlotForCwd(input.cwd);
    const runtime = slot.runtime;
    if (!supportsAgentExtensionDiscovery(runtime)) {
      throw new Error("Managed Codex runtime does not expose App discovery");
    }
    const threadId = this.#extensionThreadIdForSlot(input.threadId, slot.key);
    return await runtime.listInstalledApps({
      cwd: input.cwd,
      ...(threadId ? { threadId } : {}),
      ...(input.forceRefresh !== undefined
        ? { forceRefresh: input.forceRefresh }
        : {}),
    });
  }

  async listAvailableApps(input: {
    cwd: string;
    threadId?: string | undefined;
    forceRefresh?: boolean | undefined;
  }): Promise<AgentAppSummary[]> {
    const slot = await this.#runtimeSlotForCwd(input.cwd);
    const runtime = slot.runtime;
    if (!supportsAgentExtensionDiscovery(runtime)) {
      throw new Error("Managed Codex runtime does not expose App directory discovery");
    }
    const threadId = this.#extensionThreadIdForSlot(input.threadId, slot.key);
    return await runtime.listAvailableApps({
      cwd: input.cwd,
      ...(threadId ? { threadId } : {}),
      ...(input.forceRefresh !== undefined
        ? { forceRefresh: input.forceRefresh }
        : {}),
    });
  }

  async readApps(input: {
    cwd: string;
    appIds: string[];
    includeTools?: boolean | undefined;
  }): Promise<AgentAppReadResult> {
    const runtime = (await this.#runtimeSlotForCwd(input.cwd)).runtime;
    if (!supportsAgentExtensionDiscovery(runtime)) {
      throw new Error("Managed Codex runtime does not expose App discovery");
    }
    return await runtime.readApps(input);
  }

  async listNativeExtensionFeatures(input: {
    cwd: string;
  }): Promise<AgentNativeFeatureSummary[]> {
    const runtime = (await this.#runtimeSlotForCwd(input.cwd)).runtime;
    if (!supportsAgentExtensionDiscovery(runtime)) {
      throw new Error("Managed Codex runtime does not expose extension feature discovery");
    }
    return await runtime.listNativeExtensionFeatures(input);
  }

  async listMcpServers(input: {
    cwd: string;
    threadId?: string | undefined;
  }): Promise<AgentMcpServerSummary[]> {
    const slot = await this.#runtimeSlotForCwd(input.cwd);
    const runtime = slot.runtime;
    if (!supportsAgentExtensionDiscovery(runtime)) {
      throw new Error("Managed Codex runtime does not expose MCP discovery");
    }
    const threadId = this.#extensionThreadIdForSlot(input.threadId, slot.key);
    return await runtime.listMcpServers({
      cwd: input.cwd,
      ...(threadId ? { threadId } : {}),
    });
  }

  async listThreads(input: {
    cwd: string;
    limit?: number | undefined;
  }): Promise<AgentThreadSummary[]> {
    const slot = await this.#runtimeSlotForCwd(input.cwd);
    const runtime = slot.runtime;
    if (!supportsAgentThreadManagement(runtime)) {
      throw new Error("Managed Codex runtime does not expose thread management");
    }
    const threads = await runtime.listThreads(input);
    for (const thread of threads) this.#threadRuntimeKeys.set(thread.id, slot.key);
    return threads;
  }

  async archiveThread(threadId: string): Promise<void> {
    const runtime = this.#runtimeForThread(threadId);
    if (!supportsAgentThreadManagement(runtime)) {
      throw new Error("Managed Codex runtime does not expose thread management");
    }
    await runtime.archiveThread(threadId);
    this.#threadRuntimeKeys.delete(threadId);
  }

  async resolveRuntimeHome(input: { cwd: string }): Promise<string> {
    const scope = await this.#projectRuntimeScope(input.cwd);
    return scope?.codexHome ?? resolve(this.env.CODEX_MANAGED_HOME);
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    const runtime = this.#runtime;
    const bridge = this.#bridge;
    const workspace = this.#workspace;
    const projectSlots = [...this.#projectRuntimes.values()];
    this.#runtime = undefined;
    this.#bridge = undefined;
    this.#workspace = undefined;
    this.#projectRuntimes.clear();
    this.#projectRuntimeStarting.clear();
    this.#threadRuntimeKeys.clear();
    this.#activeRuntimeConfig = undefined;
    this.#activeModelCatalog = undefined;
    this.#bridgeToken = undefined;
    this.#canonicalWorkspaceRoot = undefined;
    this.#sharedSkillRoots = [];
    this.#externalSkillManager = undefined;
    this.#externalSkillMutationTail = Promise.resolve();
    this.#externalMcpManager = undefined;
    this.#externalMcpRegistry = {
      version: EXTERNAL_MCP_REGISTRY_VERSION,
      packages: [],
    };
    this.#externalMcpMutationTail = Promise.resolve();
    this.#extensionControlLedger = undefined;

    await Promise.all(
      projectSlots.map(async (slot) => {
        await slot.runtime.stop().catch(() => undefined);
        await slot.workspace.cleanup().catch(() => undefined);
      }),
    );
    await runtime?.stop().catch(() => undefined);
    await bridge?.stop().catch(() => undefined);
    await workspace?.cleanup().catch(() => undefined);
  }

  async #startOnce(): Promise<void> {
    const token = this.dependencies.createToken?.()
      ?? randomBytes(32).toString("hex");
    this.#bridgeToken = token;
    this.#canonicalWorkspaceRoot = await resolveConfiguredWorkspaceRoot(
      this.env.FLORAL_WORKSPACE_ROOT,
    );
    const externalSkillPackagesRoot = this.#externalSkillPackagesRoot();
    await mkdir(externalSkillPackagesRoot, {
      recursive: true,
      mode: 0o700,
    });
    await chmod(externalSkillPackagesRoot, 0o700)
      .catch(() => undefined);

    const builtInSkillRoot = resolve(process.cwd(), "skills");
    const externalSkillRoots = await (this.dependencies.resolveExternalSkillRoots?.()
      ?? resolveEnabledExternalSkillRoots({
        repositoryRoot: process.cwd(),
        dataDir: this.env.DATA_DIR,
        strict: false,
        onWarning: (message) => {
          process.stderr.write(`agent.stack.external_skills.warning=${message}\n`);
        },
      }));
    this.#sharedSkillRoots = uniqueAbsolutePaths([builtInSkillRoot, ...externalSkillRoots]);
    process.stderr.write(`agent.stack.skills.roots=${String(this.#sharedSkillRoots.length)}\n`);
    process.stderr.write(`agent.stack.skills.external=${String(externalSkillRoots.length)}\n`);
    this.#externalMcpRegistry = await (this.dependencies.readExternalMcpRegistry?.()
      ?? this.#externalMcpManagerForRuntime().readRegistry());
    process.stderr.write(
      `agent.stack.external_mcp.registry=${externalMcpRegistryFingerprint(this.#externalMcpRegistry)}\n`,
    );
    process.stderr.write(
      `agent.stack.external_mcp.installed=${String(this.#externalMcpRegistry.packages.length)}\n`,
    );
    const search = await (this.dependencies.checkSearch?.()
      ?? checkSearxng(
        this.env.SEARXNG_URL,
        this.env.SEARXNG_REQUEST_TIMEOUT_MS,
      ));
    process.stderr.write("agent.stack.search=ok\n");

    const bridge = this.dependencies.createBridge?.(token)
      ?? createResponsesBridge(this.env, token, 0, {
        costGuard: await createProjectDeepSeekCostGuard(process.cwd(), process.env),
        activityGate: this.#providerActivityGate,
      });
    this.#bridge = bridge;

    try {
      const address = await bridge.start();
      process.stderr.write("agent.stack.bridge=ok\n");

      const legacyConfig = buildCodexDeepSeekConfig({
        model: this.env.DEEPSEEK_MODEL,
        bridgeBaseUrl: address.baseUrl,
        streamIdleTimeoutMs: this.env.DEEPSEEK_REQUEST_TIMEOUT_MS,
        searchMcp: {
          searxngUrl: search.endpoint,
          packageSpec: this.env.SEARXNG_MCP_PACKAGE,
          startupTimeoutSec: this.env.SEARXNG_MCP_STARTUP_TIMEOUT_SEC,
          toolTimeoutSec: this.env.SEARXNG_MCP_TOOL_TIMEOUT_SEC,
        },
      });
      const adoption = await this.#prepareCodexConfig(legacyConfig, address.baseUrl);
      // Never let a previous successful report survive into a new unified
      // startup attempt. A missing or rollback report is safer than stale
      // evidence claiming that the current process activated unified config.
      await this.#clearCutoverReport(adoption.mode !== "unified");
      await this.#clearMcpRegistryReport(adoption.mode !== "unified");
      await this.#startCodexRuntime(adoption, legacyConfig, token);
    } catch (error) {
      const runtime = this.#runtime;
      const workspace = this.#workspace;
      this.#runtime = undefined;
      this.#workspace = undefined;
      this.#bridge = undefined;
      await runtime?.stop().catch(() => undefined);
      await bridge.stop().catch(() => undefined);
      await workspace?.cleanup().catch(() => undefined);
      throw error;
    }
  }

  async #startCodexRuntime(
    adoption: CodexConfigAdoptionResult,
    legacyConfig: string,
    token: string,
  ): Promise<void> {
    const managedCodexHome = resolve(this.env.CODEX_MANAGED_HOME);
    const modelCatalog = renderCodexModelCatalog(this.env.DEEPSEEK_MODEL);
    let workspace = await this.#createWorkspace(
      renderExternalMcpOverlay(adoption.productionConfig, this.#externalMcpRegistry),
      managedCodexHome,
      adoption.fallbackConfig
        ? renderExternalMcpOverlay(adoption.fallbackConfig, this.#externalMcpRegistry)
        : undefined,
      modelCatalog,
    );
    process.stderr.write("agent.stack.codex_home=persistent\n");
    process.stderr.write(`agent.stack.codex_model_catalog.fingerprint=${codexModelCatalogFingerprint(modelCatalog)}\n`);
    process.stderr.write("agent.stack.codex_model_catalog=active\n");
    let runtime = this.#createRuntime(workspace.codexHome, token);

    try {
      await runtime.start();
      if (adoption.mode === "unified") {
        await this.#recordMcpRegistryAdoption(adoption);
        await this.#recordCutover(adoption, legacyConfig, "active", "unified", {
          fallbackUsed: false,
          reasonCode: "unified-started",
        });
        process.stderr.write("agent.stack.codex_config.cutover=active\n");
      }
      this.#workspace = workspace;
      this.#runtime = runtime;
      this.#activeRuntimeConfig = adoption.productionConfig;
      this.#activeModelCatalog = modelCatalog;
      process.stderr.write("agent.stack.codex=ok\n");
      return;
    } catch (unifiedError) {
      await runtime.stop().catch(() => undefined);
      if (adoption.mode !== "unified" || !adoption.fallbackConfig) {
        await workspace.cleanup().catch(() => undefined);
        throw unifiedError;
      }

      process.stderr.write(
        `agent.stack.codex_config.rollback=legacy:${errorName(unifiedError)}\n`,
      );
      await this.#clearMcpRegistryReport(true);
      try {
        const fallbackWithExternalMcp = renderExternalMcpOverlay(
          adoption.fallbackConfig,
          this.#externalMcpRegistry,
        );
        if (workspace.replaceConfig) {
          await workspace.replaceConfig(fallbackWithExternalMcp);
        } else {
          await workspace.cleanup();
          workspace = await this.#createWorkspace(
            fallbackWithExternalMcp,
            managedCodexHome,
            undefined,
            modelCatalog,
          );
        }
        runtime = this.#createRuntime(workspace.codexHome, token);
        await runtime.start();
        await this.#recordCutover(adoption, legacyConfig, "rolled-back", "legacy", {
          fallbackUsed: true,
          reasonCode: "unified-start-failed-legacy-recovered",
          startupError: unifiedError,
        }).catch((reportError) => {
          process.stderr.write(
            `agent.stack.codex_config.cutover_report=error:${errorName(reportError)}\n`,
          );
        });
        this.#workspace = workspace;
        this.#runtime = runtime;
        this.#activeRuntimeConfig = adoption.fallbackConfig;
        this.#activeModelCatalog = modelCatalog;
        process.stderr.write("agent.stack.codex_config.cutover=rolled-back\n");
        process.stderr.write("agent.stack.codex=ok\n");
        return;
      } catch (fallbackError) {
        await runtime.stop().catch(() => undefined);
        await workspace.cleanup().catch(() => undefined);
        await this.#recordCutover(adoption, legacyConfig, "failed", "none", {
          fallbackUsed: true,
          reasonCode: "unified-and-legacy-start-failed",
          startupError: unifiedError,
          fallbackError,
        }).catch(() => undefined);
        throw new AggregateError(
          [unifiedError, fallbackError],
          "Codex unified startup and legacy rollback both failed",
        );
      }
    }
  }

  async #prepareCodexConfig(
    legacyConfig: string,
    bridgeBaseUrl: string,
  ): Promise<CodexConfigAdoptionResult> {
    try {
      const adoption = await (this.dependencies.prepareCodexConfig?.({
        legacyConfig,
        bridgeBaseUrl,
      }) ?? prepareCodexConfigAdoption({
        repositoryRoot: process.cwd(),
        environment: process.env,
        legacyConfig,
        bridgeBaseUrl,
      }));
      process.stderr.write(`agent.stack.codex_config.mode=${adoption.mode}\n`);
      if (adoption.shadowReport) {
        process.stderr.write(
          `agent.stack.codex_config.shadow=${adoption.shadowReport.status}\n`,
        );
        process.stderr.write(
          `agent.stack.codex_config.shadow_fingerprint=${adoption.shadowReport.reportFingerprint}\n`,
        );
      }
      return adoption;
    } catch (error) {
      await (this.dependencies.clearCodexShadowReport?.()
        ?? removeCodexShadowReport(process.cwd())).catch(() => undefined);
      process.stderr.write(
        `agent.stack.codex_config.shadow=error:${errorName(error)}\n`,
      );
      // Configuration adoption remains fail-open to the established legacy
      // generator. Diagnostics keep the cutover blocked until a unified
      // startup record proves that the controlled switch succeeded.
      return { mode: "legacy", productionConfig: legacyConfig };
    }
  }

  async #createWorkspace(
    config: string,
    codexHome: string,
    fallbackConfig?: string,
    modelCatalog = renderCodexModelCatalog(this.env.DEEPSEEK_MODEL),
  ): Promise<ManagedWorkspace> {
    const options = {
      ...(fallbackConfig ? { fallbackConfig } : {}),
      modelCatalog,
    };
    return await (this.dependencies.createWorkspace?.(config, codexHome, options)
      ?? createPersistentCodexWorkspace(codexHome, config, options));
  }

  #createRuntime(
    codexHome: string,
    bridgeToken: string,
    permissionScope?: {
      profile: string;
      cwd: string;
    },
  ): AgentRuntime {
    const approvalPolicy = this.options.codexTurnApprovalPolicy ?? "never";
    const sandboxMode = this.options.codexSandboxMode ?? "read-only";
    const approvalsReviewer = this.options.codexApprovalsReviewer ?? "user";
    const skillRoots = this.#sharedSkillRoots.length > 0
      ? [...this.#sharedSkillRoots]
      : [resolve(process.cwd(), "skills")];
    const runtimeOptions = {
      codexHome,
      bridgeToken,
      approvalPolicy,
      sandboxMode,
      approvalsReviewer,
      skillRoots,
      protectedSkillRoots: [resolve(process.cwd(), "skills")],
      externalSkillCatalog: async () => await this.#externalSkillCatalogText(),
      manageExternalSkill: async (request: ExternalSkillMutationRequest) =>
        await this.#manageExternalSkill(request),
      externalMcpCatalog: async () => await this.#externalMcpCatalogText(),
      manageExternalMcp: async (request: ExternalMcpMutationRequest) =>
        await this.#manageExternalMcp(request),
      recordAppInstallHandoff: async (appId: string) => {
        const transaction = await this.#extensionControlLedgerForRuntime().recordAppHandoff(appId);
        return { transactionId: transaction.id };
      },
      recordExtensionVerification: async (result: ExtensionVerificationResult) => {
        await this.#extensionControlLedgerForRuntime().recordVerification(result);
      },
      ...(permissionScope
        ? {
            permissionProfile: permissionScope.profile,
            permissionProfileCwd: permissionScope.cwd,
          }
        : {}),
    };
    return this.dependencies.createRuntime?.(runtimeOptions)
      ?? createCodexRuntime(
        this.env,
        codexHome,
        bridgeToken,
        runtimeOptions,
        this.options.systemAwareness,
      );
  }

  async #externalSkillCatalogText(): Promise<string> {
    return await (this.dependencies.externalSkillCatalog?.()
      ?? this.#externalSkillManagerForRuntime().listText());
  }

  async #manageExternalSkill(
    request: ExternalSkillMutationRequest,
  ): Promise<ExternalSkillManagementResult> {
    const operation = this.#externalSkillMutationTail
      .catch(() => undefined)
      .then(async () => await this.#manageExternalSkillOnce(request));
    this.#externalSkillMutationTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return await operation;
  }

  async #manageExternalSkillOnce(
    request: ExternalSkillMutationRequest,
  ): Promise<ExternalSkillManagementResult> {
    let result: ExternalSkillManagementResult;
    try {
      result = await (this.dependencies.manageExternalSkill?.(request)
        ?? this.#externalSkillManagerForRuntime().manage(request));
    } catch (error) {
      await this.#extensionControlLedgerForRuntime().recordFailure({
        kind: "external-skill",
        targetId: request.id,
        action: request.action,
        error,
      }).catch(() => undefined);
      throw error;
    }
    const transaction = await this.#extensionControlLedgerForRuntime().recordMutation({
      kind: "external-skill",
      targetId: request.id,
      action: request.action,
      changed: result.changed,
      ...(result.skillNames ? { expectedSkillNames: result.skillNames } : {}),
    });
    if (!result.changed) {
      return {
        ...result,
        transactionId: transaction.id,
        message: `${result.message}\nextension_transaction=${transaction.id}\nverification=next-turn`,
      };
    }

    const externalRoots = await (this.dependencies.resolveExternalSkillRoots?.()
      ?? this.#externalSkillManagerForRuntime().enabledRoots(true));
    this.#sharedSkillRoots = uniqueAbsolutePaths([
      resolve(process.cwd(), "skills"),
      ...externalRoots,
    ]);

    const roots = [...this.#sharedSkillRoots];
    setImmediate(() => {
      void this.#applySharedSkillRoots(roots).catch((error) => {
        process.stderr.write(
          `agent.stack.skills.hot_reload=error:${errorName(error)}\n`,
        );
      });
    });
    return {
      ...result,
      transactionId: transaction.id,
      message: `${result.message}\nhot_reload=scheduled\nrestart_required=false\nextension_transaction=${transaction.id}\nverification=next-turn`,
    };
  }

  #externalSkillManagerForRuntime(): ExternalSkillManager {
    if (!this.#externalSkillManager) {
      this.#externalSkillManager = new ExternalSkillManager({
        repositoryRoot: process.cwd(),
        dataDir: this.env.DATA_DIR,
      });
    }
    return this.#externalSkillManager;
  }

  #externalSkillPackagesRoot(): string {
    return resolveExternalSkillRegistryPaths(
      process.cwd(),
      this.env.DATA_DIR,
    ).packagesRoot;
  }

  async #applySharedSkillRoots(
    roots: string[],
  ): Promise<void> {
    const runtimes = [
      this.#runtime,
      ...[...this.#projectRuntimes.values()].map((slot) => slot.runtime),
    ].filter((runtime): runtime is AgentRuntime => Boolean(runtime));
    const uniqueRuntimes = [...new Set(runtimes)];

    const outcomes = await Promise.allSettled(
      uniqueRuntimes.map(async (runtime) => {
        if (!supportsAgentSkillControl(runtime)) return;
        await runtime.setSkillRoots(roots);
      }),
    );
    const failures = outcomes.filter(
      (outcome) => outcome.status === "rejected",
    );
    if (failures.length > 0) {
      throw new Error(
        `Unable to hot-reload Skill roots in ${String(failures.length)} runtime(s)`,
      );
    }
    process.stderr.write(
      `agent.stack.skills.hot_reload=ok:${String(roots.length)}\n`,
    );
  }

  async #externalMcpCatalogText(): Promise<string> {
    return await (this.dependencies.externalMcpCatalog?.()
      ?? this.#externalMcpManagerForRuntime().catalogText());
  }

  async #manageExternalMcp(
    request: ExternalMcpMutationRequest,
  ): Promise<ExternalMcpManagementResult> {
    const operation = this.#externalMcpMutationTail
      .catch(() => undefined)
      .then(async () => await this.#manageExternalMcpOnce(request));
    this.#externalMcpMutationTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return await operation;
  }

  async #manageExternalMcpOnce(
    request: ExternalMcpMutationRequest,
  ): Promise<ExternalMcpManagementResult> {
    let result: ExternalMcpManagementResult;
    try {
      result = await (this.dependencies.manageExternalMcp?.(request)
        ?? this.#externalMcpManagerForRuntime().mutate(request));
    } catch (error) {
      await this.#extensionControlLedgerForRuntime().recordFailure({
        kind: "external-mcp",
        targetId: request.id,
        action: request.action,
        error,
      }).catch(() => undefined);
      throw error;
    }
    const transaction = await this.#extensionControlLedgerForRuntime().recordMutation({
      kind: "external-mcp",
      targetId: request.id,
      action: request.action,
      changed: result.changed,
      expectedServerId: result.serverId ?? CURATED_EXTERNAL_MCP[request.id].serverId,
    });
    if (!result.changed) {
      return {
        ...result,
        transactionId: transaction.id,
        message: `${result.message}\nextension_transaction=${transaction.id}\nverification=next-turn`,
      };
    }
    this.#externalMcpRegistry = result.registry;
    const registry = structuredClone(result.registry);
    setImmediate(() => {
      void this.#applyExternalMcpRegistry(registry).catch((error) => {
        process.stderr.write(
          `agent.stack.external_mcp.hot_reload=error:${errorName(error)}\n`,
        );
      });
    });
    return {
      ...result,
      transactionId: transaction.id,
      message: `${result.message}\nhot_reload=scheduled\nextension_transaction=${transaction.id}\nverification=next-turn`,
    };
  }

  #extensionControlLedgerForRuntime(): ExtensionControlLedger {
    if (!this.#extensionControlLedger) {
      this.#extensionControlLedger = new ExtensionControlLedger({
        directory: resolveExtensionControlDirectory(process.cwd(), this.env.DATA_DIR),
      });
      void this.#extensionControlLedger.initialize().catch(() => undefined);
    }
    return this.#extensionControlLedger;
  }

  #externalMcpManagerForRuntime(): ExternalMcpHostManager {
    if (!this.#externalMcpManager) {
      this.#externalMcpManager = new ExternalMcpHostManager(
        process.cwd(),
        this.env.DATA_DIR,
        process.env,
      );
    }
    return this.#externalMcpManager;
  }

  async #applyExternalMcpRegistry(
    registry: ExternalMcpRegistry,
  ): Promise<void> {
    const baseConfig = this.#activeRuntimeConfig;
    const globalWorkspace = this.#workspace;
    const globalRuntime = this.#runtime;
    if (!baseConfig || !globalWorkspace || !globalRuntime) {
      throw new Error("Managed Codex runtime config is unavailable for MCP reload");
    }

    const targets: Array<{
      workspace: ManagedWorkspace;
      runtime: AgentRuntime;
      scope?: ProjectRuntimeScope | undefined;
    }> = [{ workspace: globalWorkspace, runtime: globalRuntime }];
    for (const slot of this.#projectRuntimes.values()) {
      targets.push({
        workspace: slot.workspace,
        runtime: slot.runtime,
        ...(slot.scope ? { scope: slot.scope } : {}),
      });
    }

    await Promise.all(targets.map(async (target) => {
      if (!target.workspace.replaceConfig) {
        throw new Error("Managed Codex workspace does not support config replacement");
      }
      const scopedBase = target.scope
        ? scopeCodexConfigForProject(
            baseConfig,
            resolve(process.cwd(), this.env.DATA_DIR, "inbound", "feishu"),
            target.scope,
            this.#sharedSkillRoots,
            this.#externalSkillPackagesRoot(),
          )
        : baseConfig;
      await target.workspace.replaceConfig(
        renderExternalMcpOverlay(scopedBase, registry),
      );
    }));

    const reloads = await Promise.allSettled(targets.map(async (target) => {
      if (!supportsAgentExtensionControl(target.runtime)) {
        throw new Error("Codex runtime does not expose MCP config reload");
      }
      await target.runtime.reloadMcpServers();
    }));
    const failures = reloads.filter((entry) => entry.status === "rejected");
    if (failures.length > 0) {
      throw new Error(
        `Unable to reload MCP config in ${String(failures.length)} runtime(s)`,
      );
    }
    process.stderr.write(
      `agent.stack.external_mcp.hot_reload=ok:${externalMcpRegistryFingerprint(registry)}\n`,
    );
  }

  async #recordMcpRegistryAdoption(
    adoption: CodexConfigAdoptionResult,
  ): Promise<void> {
    if (
      adoption.mode !== "unified"
      || !adoption.effectiveFingerprint
      || !adoption.mcpRegistry
    ) {
      throw new Error("Incomplete MCP registry adoption metadata");
    }
    const report = createMcpRegistryAdoptionReport({
      effectiveFingerprint: adoption.effectiveFingerprint,
      registry: adoption.mcpRegistry,
      codexConfig: adoption.productionConfig,
    });
    const path = await (this.dependencies.recordMcpRegistryAdoption?.(report)
      ?? writeMcpRegistryAdoptionReport(process.cwd(), report));
    process.stderr.write(
      `agent.stack.mcp_registry.fingerprint=${report.registryFingerprint}\n`,
    );
    process.stderr.write(
      `agent.stack.mcp_registry.report_fingerprint=${report.reportFingerprint}\n`,
    );
    process.stderr.write(`agent.stack.mcp_registry.path=${path}\n`);
    process.stderr.write("agent.stack.mcp_registry=active\n");
  }

  async #recordCutover(
    adoption: CodexConfigAdoptionResult,
    legacyConfig: string,
    status: CodexCutoverReport["status"],
    activeConfig: CodexCutoverReport["activeConfig"],
    details: Pick<
      Parameters<typeof createCodexCutoverReport>[0],
      "fallbackUsed" | "reasonCode" | "startupError" | "fallbackError"
    >,
  ): Promise<void> {
    if (
      adoption.mode !== "unified"
      || !adoption.fallbackConfig
      || !adoption.shadowReport
      || !adoption.effectiveFingerprint
      || !adoption.codexConfigFingerprint
    ) {
      throw new Error("Incomplete Codex unified cutover metadata");
    }
    const report = createCodexCutoverReport({
      status,
      activeConfig,
      effectiveFingerprint: adoption.effectiveFingerprint,
      legacyConfig,
      unifiedConfig: adoption.productionConfig,
      shadowReport: adoption.shadowReport,
      ...details,
    });
    if (report.targetCodexConfigFingerprint !== adoption.codexConfigFingerprint) {
      throw new Error("Codex unified cutover fingerprint changed after adoption preparation");
    }
    const path = await (this.dependencies.recordCodexCutover?.(report)
      ?? writeCodexCutoverReport(process.cwd(), report));
    process.stderr.write(
      `agent.stack.codex_config.cutover_fingerprint=${report.reportFingerprint}\n`,
    );
    process.stderr.write(`agent.stack.codex_config.cutover_path=${path}\n`);
  }

  async #clearCutoverReport(ignoreErrors: boolean): Promise<void> {
    const operation = this.dependencies.clearCodexCutoverReport?.()
      ?? removeCodexCutoverReport(process.cwd());
    if (ignoreErrors) {
      await operation.catch(() => undefined);
      return;
    }
    await operation;
  }

  async #clearMcpRegistryReport(ignoreErrors: boolean): Promise<void> {
    const operation = this.dependencies.clearMcpRegistryAdoptionReport?.()
      ?? removeMcpRegistryAdoptionReport(process.cwd());
    if (ignoreErrors) {
      await operation.catch(() => undefined);
      return;
    }
    await operation;
  }

  async #runtimeSlotForCwd(cwd: string): Promise<ManagedRuntimeSlot> {
    const scope = await this.#projectRuntimeScope(cwd);
    if (!scope) {
      const runtime = this.#requireRuntime();
      const workspace = this.#workspace;
      if (!workspace) throw new Error("Managed Codex workspace is not started");
      return {
        key: "global",
        runtime,
        workspace,
        codexHome: workspace.codexHome,
      };
    }

    const existing = this.#projectRuntimes.get(scope.key);
    if (existing) return existing;
    const starting = this.#projectRuntimeStarting.get(scope.key);
    if (starting) return await starting;

    const startup = this.#startProjectRuntime(scope);
    this.#projectRuntimeStarting.set(scope.key, startup);
    try {
      return await startup;
    } finally {
      this.#projectRuntimeStarting.delete(scope.key);
    }
  }

  async #startProjectRuntime(scope: ProjectRuntimeScope): Promise<ManagedRuntimeSlot> {
    const config = this.#activeRuntimeConfig;
    const modelCatalog = this.#activeModelCatalog;
    const token = this.#bridgeToken;
    if (!config || !modelCatalog || !token) {
      throw new Error("Managed Codex project runtime prerequisites are not ready");
    }

    const scopedConfig = renderExternalMcpOverlay(
      scopeCodexConfigForProject(
        config,
        resolve(process.cwd(), this.env.DATA_DIR, "inbound", "feishu"),
        scope,
        this.#sharedSkillRoots,
        this.#externalSkillPackagesRoot(),
      ),
      this.#externalMcpRegistry,
    );
    const workspace = await this.#createWorkspace(
      scopedConfig,
      scope.codexHome,
      undefined,
      modelCatalog,
    );
    const runtime = this.#createRuntime(workspace.codexHome, token, {
      profile: FLORAL_PROJECT_PERMISSION_PROFILE,
      cwd: scope.projectPath,
    });
    try {
      await runtime.start();
    } catch (error) {
      await runtime.stop().catch(() => undefined);
      await workspace.cleanup().catch(() => undefined);
      throw error;
    }

    const slot: ManagedRuntimeSlot = {
      key: scope.key,
      runtime,
      workspace,
      codexHome: workspace.codexHome,
      scope,
    };
    this.#projectRuntimes.set(scope.key, slot);
    process.stderr.write(`agent.stack.project_runtime=active:${scope.key}\n`);
    return slot;
  }

  async #projectRuntimeScope(cwd: string): Promise<ProjectRuntimeScope | undefined> {
    const workspaceRoot = this.#canonicalWorkspaceRoot;
    if (!workspaceRoot) return undefined;

    const canonicalCwd = await realpath(resolve(cwd)).catch(() => undefined);
    if (!canonicalCwd) return undefined;
    const rel = relative(workspaceRoot, canonicalCwd);
    if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || rel.includes(sep)) {
      return undefined;
    }

    const key = projectRuntimeNamespace(canonicalCwd);
    const managedHome = resolve(this.env.CODEX_MANAGED_HOME);
    const dataRoot = resolve(process.cwd(), this.env.DATA_DIR, "projects", key);
    return {
      key,
      projectPath: canonicalCwd,
      codexHome: join(managedHome, "projects", key),
      inboundRoot: join(dataRoot, "inbound", "feishu"),
    };
  }

  #extensionThreadIdForSlot(
    threadId: string | undefined,
    slotKey: string,
  ): string | undefined {
    if (!threadId) return undefined;
    if (this.#threadRuntimeKeys.get(threadId) === slotKey) return threadId;
    process.stderr.write(
      `agent.stack.extensions.thread_scope=runtime-config:${slotKey}\n`,
    );
    return undefined;
  }

  #runtimeForThread(threadId: string): AgentRuntime {
    const key = this.#threadRuntimeKeys.get(threadId);
    if (!key || key === "global") return this.#requireRuntime();
    const slot = this.#projectRuntimes.get(key);
    if (!slot) {
      throw new Error(
        "Codex thread project runtime is not loaded; refresh the project chat list before retrying",
      );
    }
    return slot.runtime;
  }

  #requireRuntime(): AgentRuntime {
    if (!this.#runtime) {
      throw new Error("Managed Codex runtime is not started");
    }
    return this.#runtime;
  }
}

async function resolveConfiguredWorkspaceRoot(
  configuredRoot: string | undefined,
): Promise<string | undefined> {
  const value = configuredRoot?.trim();
  if (!value) return undefined;
  return await realpath(resolve(value));
}

function errorName(error: unknown): string {
  return error instanceof Error && error.name ? error.name : "Error";
}

function createCodexRuntime(
  env: AppEnv,
  codexHome: string,
  bridgeToken: string,
  execution: {
    approvalPolicy: "never" | "on-request" | "untrusted";
    sandboxMode: "read-only" | "workspace-write";
    approvalsReviewer: "user";
    skillRoots: string[];
    protectedSkillRoots: string[];
    externalSkillCatalog: () => Promise<string>;
    manageExternalSkill: (
      request: ExternalSkillMutationRequest,
    ) => Promise<ExternalSkillManagementResult>;
    externalMcpCatalog: () => Promise<string>;
    manageExternalMcp: (
      request: ExternalMcpMutationRequest,
    ) => Promise<ExternalMcpManagementResult>;
    recordAppInstallHandoff: (appId: string) => Promise<{ transactionId: string }>;
    recordExtensionVerification: (result: ExtensionVerificationResult) => Promise<void>;
    permissionProfile?: string | undefined;
    permissionProfileCwd?: string | undefined;
  },
  systemAwareness?: ManagedSystemAwarenessOptions | undefined,
): AgentRuntime {
  const processEnv: NodeJS.ProcessEnv = {
    ...process.env,
    CODEX_HOME: codexHome,
    FLORAL_BRIDGE_TOKEN: bridgeToken,
  };
  delete processEnv.DEEPSEEK_API_KEY;
  // Machine-local trust boundaries belong to the FLORAL parent process,
  // not to Codex or model-visible shell environments.
  delete processEnv.FLORAL_REMOTE_MODE_CEILING;
  delete processEnv.FLORAL_MAINTENANCE_MODE_CEILING;
  delete processEnv.FLORAL_MAINTENANCE_MAX_ACTIONS_PER_HOUR;
  delete processEnv.FLORAL_MAINTENANCE_COOLDOWN_MS;
  delete processEnv.FLORAL_MAINTENANCE_FAILURE_THRESHOLD;
  delete processEnv.FLORAL_MAINTENANCE_SELF_HEAL_INTERVAL_MS;
  delete processEnv.FLORAL_WORKSPACE_ROOT;

  let runtime: CodexAppServerRuntime | undefined;
  let systemReader: SystemAwarenessReader | undefined;
  const systemRuntime = systemAwareness
    ? {
        definitions: createDefaultSystemDefinitionRegistry().list(),
        snapshotProvider: async (context: SystemObservationContext) => {
          if (!runtime) throw new Error("Codex system awareness runtime is not initialized");
          systemReader ??= createDefaultSystemAwarenessReader({
            repositoryRoot: systemAwareness.repositoryRoot,
            authority: systemAwareness.authority,
            env,
            runtime,
            environment: systemAwareness.environment ?? process.env,
          });
          return (await systemReader.read(context)).snapshot;
        },
      }
    : undefined;

  runtime = new CodexAppServerRuntime({
    command: env.CODEX_COMMAND,
    args: env.CODEX_ARGS.split(/\s+/).filter(Boolean),
    requestTimeoutMs: env.CODEX_REQUEST_TIMEOUT_MS,
    defaultModel: env.DEEPSEEK_MODEL,
    approvalPolicy: execution.approvalPolicy,
    sandboxMode: execution.sandboxMode,
    approvalsReviewer: execution.approvalsReviewer,
    processCwd: env.CODEX_CWD,
    skillRoots: execution.skillRoots,
    protectedSkillRoots: execution.protectedSkillRoots,
    externalSkillCatalog: execution.externalSkillCatalog,
    manageExternalSkill: execution.manageExternalSkill,
    externalMcpCatalog: execution.externalMcpCatalog,
    manageExternalMcp: execution.manageExternalMcp,
    recordAppInstallHandoff: execution.recordAppInstallHandoff,
    recordExtensionVerification: execution.recordExtensionVerification,
    permissionProfile: execution.permissionProfile,
    permissionProfileCwd: execution.permissionProfileCwd,
    ...(systemRuntime ? { systemAwareness: systemRuntime } : {}),
    processEnv,
  });
  return runtime;
}
