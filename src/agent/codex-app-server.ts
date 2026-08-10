import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  AgentAppReadResult,
  AgentAppSummary,
  AgentGoal,
  AgentMcpServerSummary,
  AgentNativeFeatureSummary,
  AgentRuntime,
  AgentSkillSummary,
  AgentThreadSummary,
  DurableJournal,
} from "../core/contracts.js";
import type {
  AgentApprovalHandler,
  AgentApprovalRequest,
  AgentArtifact,
  AgentArtifactDeliveryHandler,
  AgentArtifactRegistrationHandler,
  AgentEvent,
  AgentRunRequest,
  AgentRunResult,
  AgentSystemMaintenanceHandler,
} from "../core/types.js";
import {
  CodexRuntimeError,
  classifyCodexFailure,
  codexProtocolError,
  codexRequestTimeout,
} from "./codex-errors.js";
import { capabilityForMcpTool } from "../policy/authorization-authority.js";
import {
  CodexGoalClient,
  executeGoalDynamicTool,
  readGoalDynamicCall,
  type GoalSetInput,
} from "./codex-goals.js";
import { buildGithubMcpApprovalScope } from "./github-mcp-approval.js";
import {
  parseCodexThreadList,
  type CodexThreadListResponse,
} from "./codex-thread-list.js";
import type {
  ExternalSkillManagementResult,
  ExternalSkillMutationRequest,
} from "../skills/external-skill-manager.js";
import { isCuratedExternalMcpServer } from "../extensions/external-mcp-registry.js";
import {
  CURATED_EXTERNAL_SKILLS,
  type ExternalSkillCatalogId,
} from "../skills/external-skill-registry.js";
import {
  extensionCapabilityForAction,
  externalMcpApprovalScope,
  externalSkillApprovalScope,
} from "../extensions/extension-approval.js";
import type {
  ExternalMcpManagementResult,
  ExternalMcpMutationRequest,
} from "../extensions/external-mcp-manager.js";
import {
  buildExtensionPlan,
  buildExtensionVerification,
  formatExtensionPlan,
  formatExtensionVerification,
  formatExtensionControlHistory,
  readExtensionControlTransactionFromSnapshot,
  readExtensionControlTransactionsFromSnapshot,
  type ExtensionVerificationResult,
} from "../extensions/extension-control.js";
import {
  CodexRpcClient,
  type CodexExitEvent,
  type CodexServerRequest,
} from "./codex-rpc-client.js";
import type { SystemObservationContext } from "../system-awareness/index.js";
import {
  FloralContextToolController,
} from "./floral-context-tools.js";
import {
  FloralSystemToolController,
  type CodexSystemAwarenessOptions,
} from "./floral-system-tools.js";
import { FloralExtensionSnapshotStore } from "./floral-extension-snapshot.js";
import { FloralArtifactToolController } from "./floral-artifact-tools.js";
import { FloralProjectSkillToolController } from "./floral-project-skill-tools.js";
import { FloralNativeExtensionToolController } from "./floral-native-extension-tools.js";
import {
  extensionIntentForAction,
  formatMcpServersForTool,
  normalizeAppIds,
  readExtensionApplyKind,
  readExtensionPlanIntent,
  readExtensionPlanKind,
  readExtensionPlanTargetId,
  readExternalMcpAction,
  readExternalMcpId,
} from "./floral-extension-tools.js";
import {
  boundedDynamicToolText,
  dynamicToolResponse,
  safeDynamicToolToken,
} from "./floral-tool-response.js";
import {
  FLORAL_AGENT_DEVELOPER_INSTRUCTIONS,
  FLORAL_DYNAMIC_TOOLS,
  FLORAL_SYSTEM_DEVELOPER_INSTRUCTIONS,
  FLORAL_SYSTEM_DYNAMIC_TOOLS,
} from "./floral-tool-manifest.js";
export { FLORAL_AGENT_DEVELOPER_INSTRUCTIONS } from "./floral-tool-manifest.js";
export type { CodexSystemAwarenessOptions } from "./floral-system-tools.js";

interface ThreadResponse {
  thread: { id: string };
}

interface TurnResponse {
  turn: { id: string; status?: string };
}

interface PermissionProfileListResponse {
  data?: Array<{
    id?: unknown;
    description?: unknown;
    allowed?: unknown;
  }> | undefined;
}

interface SkillsListResponse {
  data?: Array<{
    cwd?: unknown;
    skills?: Array<{
      name?: unknown;
      description?: unknown;
      path?: unknown;
      scope?: unknown;
      enabled?: unknown;
    }> | undefined;
    errors?: unknown[] | undefined;
  }>;
}

interface AppInstalledResponse {
  apps?: Array<{
    id?: unknown;
    runtimeName?: unknown;
    enabled?: unknown;
    callable?: unknown;
  }> | undefined;
}

interface AppListResponse {
  data?: Array<{
    id?: unknown;
    name?: unknown;
    description?: unknown;
    installUrl?: unknown;
    isAccessible?: unknown;
    isEnabled?: unknown;
  }> | undefined;
  nextCursor?: unknown;
}

interface McpServerStatusListResponse {
  data?: unknown[] | undefined;
  nextCursor?: unknown;
}

interface AppReadResponse {
  apps?: Array<{
    id?: unknown;
    name?: unknown;
    description?: unknown;
    pluginDisplayNames?: unknown;
    toolSummaries?: unknown;
  }> | undefined;
  missingAppIds?: unknown;
}

interface ExperimentalFeatureListResponse {
  data?: Array<{
    name?: unknown;
    stage?: unknown;
    enabled?: unknown;
    defaultEnabled?: unknown;
  }> | undefined;
  nextCursor?: unknown;
}

interface TurnCompletedParams {
  threadId?: string;
  turn: {
    id: string;
    status: string;
    error?: unknown;
    items?: unknown[];
  };
}

interface ItemLifecycleParams {
  threadId?: string;
  turnId?: string;
  item?: {
    id?: string;
    type?: string;
    text?: string;
    phase?: string;
    server?: string;
    tool?: string;
    status?: string;
    arguments?: unknown;
    result?: unknown;
    namespace?: string;
    error?: unknown;
    command?: string;
    cwd?: string;
    changes?: Array<{ path?: string; kind?: string; diff?: string }>;
  };
}

interface AgentDeltaParams {
  threadId?: string;
  turnId?: string;
  itemId?: string;
  delta?: string;
  text?: string;
}

interface ErrorNotificationParams {
  threadId?: string;
  turnId?: string;
  error?: unknown;
}

export interface CodexAppServerOptions {
  command: string;
  args: string[];
  requestTimeoutMs: number;
  defaultModel: string | undefined;
  approvalPolicy?: "never" | "on-request" | "untrusted" | undefined;
  sandboxMode?: "read-only" | "workspace-write" | undefined;
  approvalsReviewer?: "user" | "auto_review" | undefined;
  developerInstructions?: string | undefined;
  processCwd?: string | undefined;
  processEnv?: NodeJS.ProcessEnv | undefined;
  skillRoots?: string[] | undefined;
  protectedSkillRoots?: string[] | undefined;
  skillAuthoringDataRoot?: string | undefined;
  externalSkillCatalog?: (() => Promise<string>) | undefined;
  manageExternalSkill?: ((
    request: ExternalSkillMutationRequest,
  ) => Promise<ExternalSkillManagementResult>) | undefined;
  externalMcpCatalog?: (() => Promise<string>) | undefined;
  manageExternalMcp?: ((
    request: ExternalMcpMutationRequest,
  ) => Promise<ExternalMcpManagementResult>) | undefined;
  recordAppInstallHandoff?: ((appId: string) => Promise<{ transactionId: string }>) | undefined;
  recordAppConfigMutation?: ((input: {
    appId: string;
    action: "enable" | "disable";
    changed: boolean;
  }) => Promise<{ transactionId: string }>) | undefined;
  recordExtensionVerification?: ((result: ExtensionVerificationResult) => Promise<void>) | undefined;
  permissionProfile?: string | undefined;
  permissionProfileCwd?: string | undefined;
  systemAwareness?: CodexSystemAwarenessOptions | undefined;
  durableJournal?: DurableJournal | undefined;
}

interface TurnTerminalState {
  params: TurnCompletedParams;
  errorNotification: unknown;
}

interface InFlightMcpToolCall {
  threadId: string;
  turnId: string;
  itemId: string;
  server: string;
  tool: string;
  arguments: Record<string, unknown>;
}

export class CodexAppServerRuntime implements AgentRuntime {
  readonly name = "codex-app-server";
  readonly #client: CodexRpcClient;
  readonly #goals: CodexGoalClient;
  readonly #defaultModel: string | undefined;
  readonly #turnTimeoutMs: number;
  readonly #approvalPolicy: "never" | "on-request" | "untrusted";
  readonly #sandboxMode: "read-only" | "workspace-write";
  readonly #approvalsReviewer: "user" | "auto_review";
  readonly #developerInstructions: string;
  #skillRoots: string[];
  readonly #protectedSkillRoots: string[];
  readonly #projectSkillTools: FloralProjectSkillToolController;
  readonly #nativeExtensionTools: FloralNativeExtensionToolController;
  readonly #externalSkillCatalog: (() => Promise<string>) | undefined;
  readonly #manageExternalSkill: ((
    request: ExternalSkillMutationRequest,
  ) => Promise<ExternalSkillManagementResult>) | undefined;
  readonly #externalMcpCatalog: (() => Promise<string>) | undefined;
  readonly #manageExternalMcp: ((
    request: ExternalMcpMutationRequest,
  ) => Promise<ExternalMcpManagementResult>) | undefined;
  readonly #recordExtensionVerification: ((result: ExtensionVerificationResult) => Promise<void>) | undefined;
  readonly #permissionProfile: string | undefined;
  readonly #permissionProfileCwd: string | undefined;
  readonly #systemTools: FloralSystemToolController;
  readonly #loadedThreads = new Set<string>();
  readonly #activeTurns = new Map<string, string>();
  readonly #eventHandlers = new Map<string, (event: AgentEvent) => void>();
  readonly #approvalHandlers = new Map<string, AgentApprovalHandler>();
  readonly #mcpToolApprovalHandlers = new Map<string, AgentApprovalHandler>();
  readonly #skillManagementApprovalHandlers = new Map<string, AgentApprovalHandler>();
  readonly #extensionManagementApprovalHandlers = new Map<string, AgentApprovalHandler>();
  readonly #systemMaintenanceApprovalHandlers = new Map<string, AgentApprovalHandler>();
  readonly #systemMaintenanceHandlers = new Map<string, AgentSystemMaintenanceHandler>();
  readonly #artifactRegistrationHandlers = new Map<string, AgentArtifactRegistrationHandler>();
  readonly #artifactDeliveryHandlers = new Map<string, AgentArtifactDeliveryHandler>();
  readonly #artifactTools = new FloralArtifactToolController();
  readonly #threadCwds = new Map<string, string>();
  readonly #extensionSnapshots: FloralExtensionSnapshotStore;
  readonly #extensionMutationPendingVerification = new Set<string>();
  readonly #extensionVerificationShellSoftBlocked = new Set<string>();
  readonly #contextTools: FloralContextToolController;
  readonly #approvalItemSummaries = new Map<string, string>();
  readonly #inFlightMcpToolCalls = new Map<string, InFlightMcpToolCall>();
  #skillsDirty = false;
  #started = false;

  constructor(options: CodexAppServerOptions) {
    this.#client = new CodexRpcClient({
      command: options.command,
      args: options.args,
      requestTimeoutMs: options.requestTimeoutMs,
      cwd: options.processCwd,
      env: options.processEnv,
    });
    this.#goals = new CodexGoalClient(
      async (method, params) => this.#client.request(method, params),
      codexProtocolError,
    );
    this.#defaultModel = options.defaultModel;
    this.#turnTimeoutMs = options.requestTimeoutMs;
    this.#approvalPolicy = options.approvalPolicy ?? "never";
    this.#sandboxMode = options.sandboxMode ?? "read-only";
    this.#approvalsReviewer = options.approvalsReviewer ?? "user";
    this.#developerInstructions = options.developerInstructions?.trim()
      || FLORAL_AGENT_DEVELOPER_INSTRUCTIONS;
    this.#skillRoots = normalizeSkillRoots(options.skillRoots ?? []);
    this.#protectedSkillRoots = normalizeSkillRoots(
      options.protectedSkillRoots ?? [],
    );
    this.#projectSkillTools = new FloralProjectSkillToolController({
      runtimeDataRoot: resolve(
        options.skillAuthoringDataRoot ?? join(options.processCwd ?? process.cwd(), "data", "skill-authoring"),
      ),
      listSkills: async (cwd, forceReload) => await this.listSkills({ cwd, forceReload }),
      writeSkillEnabled: async (path, enabled) => {
        await this.#client.request("skills/config/write", { path, name: null, enabled });
        this.#skillsDirty = true;
      },
    });
    this.#externalSkillCatalog = options.externalSkillCatalog;
    this.#manageExternalSkill = options.manageExternalSkill;
    this.#externalMcpCatalog = options.externalMcpCatalog;
    this.#manageExternalMcp = options.manageExternalMcp;
    this.#recordExtensionVerification = options.recordExtensionVerification;
    this.#nativeExtensionTools = new FloralNativeExtensionToolController({
      writeAppEnabled: async (appId, enabled) => await this.#client.request("config/value/write", {
        keyPath: `apps.${appId}.enabled`,
        value: enabled,
        mergeStrategy: "upsert",
      }),
      listInstalledApps: async (cwd, threadId) => await this.listInstalledApps({
        cwd,
        threadId,
        forceRefresh: true,
      }),
      recordAppInstallHandoff: options.recordAppInstallHandoff,
      recordAppConfigMutation: options.recordAppConfigMutation,
    });
    this.#contextTools = new FloralContextToolController(options.durableJournal);
    this.#permissionProfile = options.permissionProfile?.trim() || undefined;
    this.#permissionProfileCwd = options.permissionProfileCwd?.trim()
      ? resolve(options.permissionProfileCwd)
      : undefined;
    this.#systemTools = new FloralSystemToolController(options.systemAwareness);
    this.#extensionSnapshots = new FloralExtensionSnapshotStore({
      listFeatures: async (cwd) => await this.listNativeExtensionFeatures({ cwd }),
      listInstalledApps: async (cwd, threadId) =>
        await this.listInstalledApps({ cwd, threadId, forceRefresh: false }),
      listAvailableApps: async (cwd, threadId) =>
        await this.listAvailableApps({ cwd, threadId, forceRefresh: false }),
      listMcpServers: async (cwd, threadId) => await this.listMcpServers({ cwd, threadId }),
      readApps: async (cwd, appIds) =>
        await this.readApps({ cwd, appIds, includeTools: true }),
    });
    this.#client.on("serverRequest", (request: CodexServerRequest) => {
      void this.#handleServerRequest(request).catch(() => {
        this.#respondSafely(request.id, undefined, {
          code: -32603,
          message: "FLORAL rejected an approval request after an internal authorization error",
        });
      });
    });
    this.#client.on("notification:skills/changed", () => {
      this.#skillsDirty = true;
      process.stderr.write("agent.stack.skills.changed=1\n");
    });
  }

  async start(): Promise<void> {
    if (this.#started) return;

    await this.#client.start();
    try {
      await this.#client.initialize(
        {
          name: "mac_agent_gateway",
          title: "Mac Agent Gateway",
          version: "0.1.0",
        },
        { experimentalApi: true },
      );
      if (this.#permissionProfile) {
        await this.#assertPermissionProfileAvailable();
      }
      if (this.#skillRoots.length > 0) {
        await this.#client.request("skills/extraRoots/set", {
          extraRoots: this.#skillRoots,
        });
        process.stderr.write(
          `agent.stack.skills.roots=${String(this.#skillRoots.length)}\n`,
        );
      }
      this.#started = true;
    } catch (error) {
      await this.#client.stop();
      throw error;
    }
  }

  async #assertPermissionProfileAvailable(): Promise<void> {
    const profile = this.#permissionProfile;
    if (!profile) return;
    const response = await this.#client.request<PermissionProfileListResponse>(
      "permissionProfile/list",
      {
        cursor: null,
        limit: 100,
        ...(this.#permissionProfileCwd ? { cwd: this.#permissionProfileCwd } : {}),
      },
    );
    const entries = Array.isArray(response?.data) ? response.data : [];
    const selected = entries.find((entry) =>
      typeof entry?.id === "string" && entry.id === profile
    );
    if (!selected) {
      throw codexProtocolError(
        `Codex permission profile is not available: ${profile}`,
      );
    }
    if (selected.allowed !== true) {
      throw codexProtocolError(
        `Codex permission profile is blocked by effective requirements: ${profile}`,
      );
    }
    process.stderr.write(`agent.stack.permissions.profile=${profile}\n`);
  }

  async listSkills(input: {
    cwd: string;
    forceReload?: boolean | undefined;
  }): Promise<AgentSkillSummary[]> {
    this.#ensureStarted();
    const cwd = resolve(input.cwd);
    const response = await this.#client.request<SkillsListResponse>(
      "skills/list",
      {
        cwds: [cwd],
        forceReload: input.forceReload === true || this.#skillsDirty,
      },
    );
    const entry = Array.isArray(response?.data)
      ? response.data.find((candidate) =>
          typeof candidate?.cwd === "string" && resolve(candidate.cwd) === cwd
        ) ?? response.data[0]
      : undefined;
    const skills = Array.isArray(entry?.skills) ? entry.skills : [];
    const output: AgentSkillSummary[] = [];
    for (const skill of skills) {
      const name = typeof skill?.name === "string" ? skill.name.trim() : "";
      const description = typeof skill?.description === "string"
        ? skill.description.trim()
        : "";
      const path = typeof skill?.path === "string" ? skill.path.trim() : "";
      const scope = normalizeSkillScope(skill?.scope);
      if (!name || !description || !path || !scope) continue;
      output.push({
        name,
        description,
        path: resolve(path),
        scope,
        enabled: skill?.enabled === true,
      });
    }
    this.#skillsDirty = false;
    return output;
  }

  async setSkillRoots(roots: string[]): Promise<void> {
    this.#ensureStarted();
    const normalized = normalizeSkillRoots(roots);
    await this.#client.request("skills/extraRoots/set", {
      extraRoots: normalized,
    });
    this.#skillRoots = normalized;
    this.#skillsDirty = true;
    process.stderr.write(
      `agent.stack.skills.roots=${String(normalized.length)}\n`,
    );
  }

  async listInstalledApps(input: {
    cwd: string;
    threadId?: string | undefined;
    forceRefresh?: boolean | undefined;
  }): Promise<AgentAppSummary[]> {
    this.#ensureStarted();
    resolve(input.cwd);
    try {
      const response = await this.#client.request<AppInstalledResponse>(
        "app/installed",
        {
          ...(input.threadId ? { threadId: input.threadId } : {}),
          forceRefresh: input.forceRefresh === true,
        },
      );
      const apps = Array.isArray(response?.apps) ? response.apps : [];
      return apps.flatMap((app) => {
        const id = readBoundedPlainText(app?.id, 160);
        if (
          !id
          || typeof app?.enabled !== "boolean"
          || typeof app?.callable !== "boolean"
        ) {
          return [];
        }
        const runtimeName = readBoundedPlainText(app?.runtimeName, 200);
        return [{
          id,
          ...(runtimeName ? { runtimeName } : {}),
          enabled: app.enabled,
          callable: app.callable,
          source: "installed-runtime",
        } satisfies AgentAppSummary];
      });
    } catch (error) {
      if (!isAppInstalledCompatibilityError(error)) throw error;
      process.stderr.write(
        `agent.stack.extensions.app_installed=fallback:${safeDynamicToolToken(
          error instanceof Error ? error.name : "Error",
        )}\n`,
      );
      return await this.#listAvailableAppsFallback(input);
    }
  }

  async #listAvailableAppsFallback(input: {
    cwd: string;
    threadId?: string | undefined;
    forceRefresh?: boolean | undefined;
  }): Promise<AgentAppSummary[]> {
    const apps = await this.listAvailableApps(input);
    return apps.map((app) => ({
      ...app,
      source: "directory-fallback" as const,
    }));
  }

  async listAvailableApps(input: {
    cwd: string;
    threadId?: string | undefined;
    forceRefresh?: boolean | undefined;
  }): Promise<AgentAppSummary[]> {
    this.#ensureStarted();
    resolve(input.cwd);
    const output: AgentAppSummary[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const response = await this.#client.request<AppListResponse>(
        "app/list",
        {
          cursor,
          limit: 100,
          ...(input.threadId ? { threadId: input.threadId } : {}),
          forceRefetch: input.forceRefresh === true,
        },
      );
      const data = Array.isArray(response?.data) ? response.data : [];
      for (const app of data) {
        const id = readBoundedPlainText(app?.id, 160);
        const runtimeName = readBoundedPlainText(app?.name, 200);
        const description = readBoundedPlainText(app?.description, 1_000);
        const installUrl = readHttpsUrl(app?.installUrl);
        if (
          !id
          || typeof app?.isEnabled !== "boolean"
          || typeof app?.isAccessible !== "boolean"
        ) {
          continue;
        }
        output.push({
          id,
          ...(runtimeName ? { runtimeName } : {}),
          ...(description ? { description } : {}),
          ...(installUrl ? { installUrl } : {}),
          enabled: app.isEnabled,
          accessible: app.isAccessible,
          source: "directory",
        });
      }
      const next = readBoundedPlainText(response?.nextCursor, 500);
      if (!next) break;
      cursor = next;
    }
    return output;
  }

  async readApps(input: {
    cwd: string;
    appIds: string[];
    includeTools?: boolean | undefined;
  }): Promise<AgentAppReadResult> {
    this.#ensureStarted();
    resolve(input.cwd);
    const appIds = normalizeAppIds(input.appIds);
    if (appIds.length === 0) {
      throw new Error("At least one valid Codex App id is required");
    }
    const response = await this.#client.request<AppReadResponse>(
      "app/read",
      {
        appIds,
        includeTools: input.includeTools === true,
      },
    );
    return parseAppReadResponse(response);
  }

  async listNativeExtensionFeatures(input: {
    cwd: string;
  }): Promise<AgentNativeFeatureSummary[]> {
    this.#ensureStarted();
    resolve(input.cwd);
    const response = await this.#client.request<ExperimentalFeatureListResponse>(
      "experimentalFeature/list",
      { cursor: null, limit: 100 },
    );
    const data = Array.isArray(response?.data) ? response.data : [];
    return data.flatMap((feature) => {
      const name = readBoundedPlainText(feature?.name, 120);
      if (name !== "apps" && name !== "plugins") return [];
      if (typeof feature?.enabled !== "boolean" || typeof feature?.defaultEnabled !== "boolean") {
        return [];
      }
      return [{
        name,
        stage: normalizeFeatureStage(feature?.stage),
        enabled: feature.enabled,
        defaultEnabled: feature.defaultEnabled,
      } satisfies AgentNativeFeatureSummary];
    });
  }

  async listMcpServers(input: {
    cwd: string;
    threadId?: string | undefined;
  }): Promise<AgentMcpServerSummary[]> {
    this.#ensureStarted();
    resolve(input.cwd);
    const output: AgentMcpServerSummary[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const response = await this.#client.request<McpServerStatusListResponse>(
        "mcpServerStatus/list",
        {
          cursor,
          limit: 100,
          ...(input.threadId ? { threadId: input.threadId } : {}),
        },
      );
      const data = Array.isArray(response?.data) ? response.data : [];
      for (const value of data) {
        const parsed = parseMcpServerStatus(value);
        if (parsed) output.push(parsed);
      }
      const next = readBoundedPlainText(response?.nextCursor, 500);
      if (!next) break;
      cursor = next;
    }
    return output;
  }

  async reloadMcpServers(): Promise<void> {
    this.#ensureStarted();
    await this.#client.request("config/mcpServer/reload", {});
    process.stderr.write("agent.stack.mcp.reload=queued\n");
  }

  async listThreads(input: {
    cwd: string;
    limit?: number | undefined;
  }): Promise<AgentThreadSummary[]> {
    this.#ensureStarted();
    const cwd = resolve(input.cwd);
    const limit = Math.max(1, Math.min(50, input.limit ?? 20));
    const response = await this.#client.request<CodexThreadListResponse>(
      "thread/list",
      {
        cursor: null,
        limit,
        cwd,
      },
    );
    return parseCodexThreadList(response);
  }

  async archiveThread(threadId: string): Promise<void> {
    this.#ensureStarted();
    const normalized = threadId.trim();
    if (!normalized) throw new Error("Thread id must not be empty");
    await this.#client.request("thread/archive", { threadId: normalized });
    this.#loadedThreads.delete(normalized);
    this.#activeTurns.delete(normalized);
    this.#eventHandlers.delete(normalized);
    this.#approvalHandlers.delete(normalized);
    this.#mcpToolApprovalHandlers.delete(normalized);
    this.#skillManagementApprovalHandlers.delete(normalized);
    this.#extensionManagementApprovalHandlers.delete(normalized);
    this.#systemMaintenanceApprovalHandlers.delete(normalized);
    this.#systemMaintenanceHandlers.delete(normalized);
    this.#artifactRegistrationHandlers.delete(normalized);
    this.#artifactDeliveryHandlers.delete(normalized);
    this.#threadCwds.delete(normalized);
    this.#contextTools.clearThread(normalized);
    this.#extensionSnapshots.clearThread(normalized);
    this.#systemTools.clearThread(normalized);
    this.#extensionMutationPendingVerification.delete(normalized);
    this.#extensionVerificationShellSoftBlocked.delete(normalized);
    this.#deleteApprovalItemSummaries(normalized);
    this.#deleteInFlightMcpToolCalls(normalized);
  }

  async getGoal(threadId: string): Promise<AgentGoal | undefined> {
    this.#ensureStarted();
    return await this.#goals.get(threadId);
  }

  async setGoal(input: GoalSetInput): Promise<AgentGoal> {
    this.#ensureStarted();
    return await this.#goals.set(input);
  }

  async clearGoal(threadId: string): Promise<boolean> {
    this.#ensureStarted();
    return await this.#goals.clear(threadId);
  }

  async run(request: AgentRunRequest, onEvent?: (event: AgentEvent) => void): Promise<AgentRunResult> {
    this.#ensureStarted();

    const cwd = resolve(request.cwd);
    const threadId = request.threadId
      ? await this.#resumeOrRecoverThread(request, cwd)
      : await this.#startThread(request, cwd);

    onEvent?.({ type: "run.started", threadId });
    this.#threadCwds.set(threadId, cwd);
    if (onEvent) this.#eventHandlers.set(threadId, onEvent);
    if (request.approvalHandler) this.#approvalHandlers.set(threadId, request.approvalHandler);
    if (request.mcpToolApprovalHandler) {
      this.#mcpToolApprovalHandlers.set(threadId, request.mcpToolApprovalHandler);
    }
    if (request.skillManagementApprovalHandler) {
      this.#skillManagementApprovalHandlers.set(
        threadId,
        request.skillManagementApprovalHandler,
      );
    }
    if (request.extensionManagementApprovalHandler) {
      this.#extensionManagementApprovalHandlers.set(
        threadId,
        request.extensionManagementApprovalHandler,
      );
    }
    if (request.systemMaintenanceApprovalHandler) {
      this.#systemMaintenanceApprovalHandlers.set(
        threadId,
        request.systemMaintenanceApprovalHandler,
      );
    }
    if (request.systemMaintenanceHandler) {
      this.#systemMaintenanceHandlers.set(threadId, request.systemMaintenanceHandler);
    }
    if (request.artifactRegistrationHandler) {
      this.#artifactRegistrationHandlers.set(threadId, request.artifactRegistrationHandler);
    }
    if (request.artifactDeliveryHandler) {
      this.#artifactDeliveryHandlers.set(threadId, request.artifactDeliveryHandler);
    }

    let streamedText = "";
    let authoritativeText = "";
    let lastAgentMessageText = "";
    let errorNotification: unknown;
    let activeTurnId: string | undefined;
    let bufferedTerminal: TurnCompletedParams | undefined;
    let terminalSettled = false;
    let resolveTerminal: ((value: TurnTerminalState) => void) | undefined;
    let rejectTerminal: ((reason: Error) => void) | undefined;

    const terminalPromise = new Promise<TurnTerminalState>((resolve, reject) => {
      resolveTerminal = resolve;
      rejectTerminal = reject;
    });

    const settleTerminal = (params: TurnCompletedParams) => {
      if (terminalSettled) return;
      if (!activeTurnId) {
        bufferedTerminal = params;
        return;
      }
      if (params.turn.id !== activeTurnId) return;
      if (params.threadId && params.threadId !== threadId) return;
      terminalSettled = true;
      resolveTerminal?.({ params, errorNotification });
    };

    const deltaListener = (value: unknown) => {
      const params = value as AgentDeltaParams;
      if (!matchesTurn(params, threadId, activeTurnId)) return;
      const delta = readTextDelta(params);
      if (!delta) return;
      streamedText += delta;
      onEvent?.({ type: "assistant.delta", text: delta });
    };

    const itemStartedListener = (value: unknown) => {
      const params = value as ItemLifecycleParams;
      if (!matchesTurn(params, threadId, activeTurnId)) return;

      // Any tool/side-effect work that starts after a narrative message turns
      // that narrative into commentary, not a safe final-answer candidate.
      // Reset streamed fallback too so a pre-tool "I'll search..." delta
      // cannot be returned as the final answer when the provider never closes
      // the tool loop with a post-tool message.
      if (isAgentWorkItem(params.item)) {
        lastAgentMessageText = "";
        streamedText = "";
      }

      const itemId = params.item?.id;
      if (itemId) {
        const approvalSummary = summarizeApprovalItem(params.item);
        if (approvalSummary) this.#approvalItemSummaries.set(approvalItemKey(threadId, itemId), approvalSummary);
      }

      const inFlightMcpTool = readInFlightMcpToolCall(params, threadId);
      if (inFlightMcpTool) {
        this.#inFlightMcpToolCalls.set(
          approvalItemKey(threadId, inFlightMcpTool.itemId),
          inFlightMcpTool,
        );
      }

      const tool = readMcpToolEvent(params.item);
      if (!tool) return;
      onEvent?.({
        type: "tool.started",
        name: tool.name,
        detail: tool.detail,
      });
    };

    const itemCompletedListener = (value: unknown) => {
      const params = value as ItemLifecycleParams;
      if (!matchesTurn(params, threadId, activeTurnId)) return;

      const itemId = params.item?.id;
      if (itemId) {
        const key = approvalItemKey(threadId, itemId);
        this.#approvalItemSummaries.delete(key);
        this.#inFlightMcpToolCalls.delete(key);
      }

      const artifact = readRegisteredMcpArtifact(params.item);
      if (artifact) {
        onEvent?.({ type: "artifact.registered", artifact });
      }

      const tool = readMcpToolEvent(params.item);
      if (tool) {
        onEvent?.({
          type: "tool.completed",
          name: tool.name,
          detail: tool.detail,
        });
        return;
      }

      if (params.item?.type !== "agentMessage" || typeof params.item.text !== "string") return;
      if (params.item.phase === "final_answer") {
        authoritativeText = params.item.text;
        return;
      }
      if (params.item.phase === "commentary") {
        lastAgentMessageText = "";
        streamedText = "";
        return;
      }
      // Older/variant app-server surfaces may omit phase. Keep an unphased
      // message as a fallback only until later tool work invalidates it.
      lastAgentMessageText = params.item.text;
    };

    const errorListener = (value: unknown) => {
      const params = value as ErrorNotificationParams;
      if (!matchesTurn(params, threadId, activeTurnId)) return;
      errorNotification = params.error ?? value;
    };

    const turnCompletedListener = (value: unknown) => {
      const params = value as TurnCompletedParams;
      if (!params?.turn?.id) return;
      settleTerminal(params);
    };

    const processErrorListener = (error: CodexRuntimeError) => {
      if (terminalSettled) return;
      terminalSettled = true;
      rejectTerminal?.(error);
    };

    const exitListener = (event: CodexExitEvent) => {
      if (terminalSettled) return;
      terminalSettled = true;
      rejectTerminal?.(event.error);
    };

    this.#client.on("notification:item/agentMessage/delta", deltaListener);
    this.#client.on("notification:item/started", itemStartedListener);
    this.#client.on("notification:item/completed", itemCompletedListener);
    this.#client.on("notification:error", errorListener);
    this.#client.on("notification:turn/completed", turnCompletedListener);
    this.#client.on("processError", processErrorListener);
    this.#client.on("exit", exitListener);

    try {
      const effectiveApprovalPolicy = request.approvalPolicy ?? this.#approvalPolicy;
      const effectiveApprovalsReviewer = request.approvalsReviewer ?? this.#approvalsReviewer;
      const requestedSandboxMode = request.sandboxMode ?? this.#sandboxMode;
      const executionContext: NonNullable<SystemObservationContext["execution"]> = {
        ...(request.controlMode
          ? {
              gateway: {
                controlMode: request.controlMode,
                sandboxMode: requestedSandboxMode,
                approvalPolicy: effectiveApprovalPolicy,
                approvalsReviewer: effectiveApprovalsReviewer,
                ...(request.approvalRoute ? { approvalRoute: request.approvalRoute } : {}),
              },
            }
          : {}),
        turn: this.#permissionProfile
          ? {
              selector: "permission-profile",
              sandboxMode: "not-applicable",
              permissionProfile: this.#permissionProfile,
              approvalPolicy: effectiveApprovalPolicy,
              approvalsReviewer: effectiveApprovalsReviewer,
            }
          : {
              selector: "sandbox-policy",
              sandboxMode: requestedSandboxMode,
              permissionProfile: "none",
              approvalPolicy: effectiveApprovalPolicy,
              approvalsReviewer: effectiveApprovalsReviewer,
            },
      };

      await this.#extensionSnapshots.capture(threadId, cwd);
      await this.#systemTools.captureSnapshot(threadId, cwd, executionContext);
      const turnInput: Array<Record<string, unknown>> = [
        { type: "text", text: request.text },
      ];
      const explicitSkillNames = extractExplicitSkillNames(request.text);
      const resolvedExplicitSkillNames = new Set<string>();
      if (explicitSkillNames.length > 0) {
        const availableSkills = await this.listSkills({ cwd });
        const byName = new Map(
          availableSkills
            .filter((skill) => skill.enabled)
            .map((skill) => [skill.name, skill] as const),
        );
        for (const name of explicitSkillNames) {
          const skill = byName.get(name);
          if (!skill) continue;
          resolvedExplicitSkillNames.add(name);
          turnInput.push({
            type: "skill",
            name: skill.name,
            path: skill.path,
          });
        }
      }
      appendExplicitAppMentions(
        turnInput,
        request.text,
        this.#extensionSnapshots.get(threadId)?.installedApps ?? [],
        resolvedExplicitSkillNames,
      );

      const turnParams: Record<string, unknown> = {
        threadId,
        input: turnInput,
        cwd,
        approvalPolicy: toAppServerApprovalPolicy(effectiveApprovalPolicy),
        approvalsReviewer: effectiveApprovalsReviewer,
      };
      if (this.#permissionProfile) {
        turnParams.permissions = this.#permissionProfile;
        turnParams.runtimeWorkspaceRoots = [cwd];
      } else {
        turnParams.sandboxPolicy = buildTurnSandboxPolicy(
          requestedSandboxMode,
          cwd,
        );
      }
      const model = request.model ?? this.#defaultModel;
      if (model) turnParams.model = model;

      const turn = await this.#client.request<TurnResponse>("turn/start", turnParams);
      activeTurnId = turn.turn.id;
      this.#activeTurns.set(threadId, activeTurnId);
      if (bufferedTerminal) settleTerminal(bufferedTerminal);

      const terminal = await withTimeout(
        terminalPromise,
        this.#turnTimeoutMs,
        () => codexRequestTimeout("turn/completed", this.#turnTimeoutMs),
      );
      const status = terminal.params.turn.status;

      if (status === "interrupted") {
        throw new CodexRuntimeError({
          kind: "interrupted",
          message: `Codex turn interrupted: ${activeTurnId}`,
          retryable: true,
          data: terminal.params,
        });
      }
      if (status === "failed") {
        if (
          this.#extensionMutationPendingVerification.has(threadId)
          && this.#extensionVerificationShellSoftBlocked.has(threadId)
        ) {
          const result = {
            threadId,
            finalText: [
              "扩展变更已写入 FLORAL 受控配置，并已安排 Codex MCP 热重载。",
              "当前回合尝试通过 shell、进程表或 ~/.codex 进行非权威验收，已被 FLORAL 安全阻止；这不代表安装失败。",
              "请在下一回合使用 floral_extensions/mcp_status，或直接使用 /mcp，依据 fresh runtime 状态与工具发现结果完成验收。",
            ].join("\n"),
          };
          process.stderr.write("codex.extension_shell_verification=soft-recovered\n");
          onEvent?.({ type: "run.completed", ...result });
          return result;
        }
        throw classifyCodexFailure(
          terminal.params.turn.error ?? terminal.errorNotification ?? terminal.params,
          { method: "turn/start", fallbackMessage: `Codex turn failed: ${activeTurnId}` },
        );
      }
      if (status !== "completed") {
        throw codexProtocolError(`Unexpected Codex turn status: ${status}`);
      }

      const finalText = authoritativeText
        || readFinalAgentText(terminal.params.turn.items)
        || lastAgentMessageText
        || streamedText;
      if (!finalText) {
        throw codexProtocolError(
          "Codex turn completed without a final agent message",
        );
      }

      const result = {
        threadId,
        finalText,
      };
      onEvent?.({ type: "run.completed", ...result });
      return result;
    } catch (error) {
      if (activeTurnId && error instanceof CodexRuntimeError && error.kind === "request_timeout") {
        await this.#interruptBestEffort(threadId, activeTurnId);
      }
      const wrapped = error instanceof CodexRuntimeError
        ? error
        : classifyCodexFailure(error, { fallbackMessage: "Codex run failed" });
      onEvent?.({ type: "run.failed", threadId, message: wrapped.message });
      throw wrapped;
    } finally {
      this.#client.off("notification:item/agentMessage/delta", deltaListener);
      this.#client.off("notification:item/started", itemStartedListener);
      this.#client.off("notification:item/completed", itemCompletedListener);
      this.#client.off("notification:error", errorListener);
      this.#client.off("notification:turn/completed", turnCompletedListener);
      this.#client.off("processError", processErrorListener);
      this.#client.off("exit", exitListener);
      this.#activeTurns.delete(threadId);
      this.#eventHandlers.delete(threadId);
      this.#approvalHandlers.delete(threadId);
      this.#mcpToolApprovalHandlers.delete(threadId);
      this.#skillManagementApprovalHandlers.delete(threadId);
      this.#extensionManagementApprovalHandlers.delete(threadId);
      this.#systemMaintenanceApprovalHandlers.delete(threadId);
      this.#systemMaintenanceHandlers.delete(threadId);
      this.#artifactRegistrationHandlers.delete(threadId);
      this.#artifactDeliveryHandlers.delete(threadId);
      this.#threadCwds.delete(threadId);
      this.#contextTools.clearThread(threadId);
      this.#extensionSnapshots.clearThread(threadId);
      this.#systemTools.clearThread(threadId);
      this.#extensionMutationPendingVerification.delete(threadId);
      this.#extensionVerificationShellSoftBlocked.delete(threadId);
      this.#deleteApprovalItemSummaries(threadId);
      this.#deleteInFlightMcpToolCalls(threadId);
    }
  }

  async interrupt(threadId: string, turnId?: string): Promise<void> {
    this.#ensureStarted();
    const resolvedTurnId = turnId ?? this.#activeTurns.get(threadId);
    if (!resolvedTurnId) {
      throw new CodexRuntimeError({
        kind: "bad_request",
        message: `No active Codex turn is known for thread ${threadId}`,
        retryable: false,
      });
    }
    await this.#client.request("turn/interrupt", { threadId, turnId: resolvedTurnId });
  }

  async stop(): Promise<void> {
    this.#started = false;
    this.#loadedThreads.clear();
    this.#activeTurns.clear();
    this.#eventHandlers.clear();
    this.#approvalHandlers.clear();
    this.#mcpToolApprovalHandlers.clear();
    this.#skillManagementApprovalHandlers.clear();
    this.#extensionManagementApprovalHandlers.clear();
    this.#systemMaintenanceApprovalHandlers.clear();
    this.#systemMaintenanceHandlers.clear();
    this.#artifactRegistrationHandlers.clear();
    this.#artifactDeliveryHandlers.clear();
    this.#threadCwds.clear();
    this.#extensionSnapshots.clear();
    this.#systemTools.clear();
    this.#extensionMutationPendingVerification.clear();
    this.#extensionVerificationShellSoftBlocked.clear();
    this.#contextTools.clear();
    this.#approvalItemSummaries.clear();
    this.#inFlightMcpToolCalls.clear();
    await this.#client.stop();
  }

  async #resumeOrRecoverThread(request: AgentRunRequest, cwd: string): Promise<string> {
    const requestedThreadId = request.threadId;
    if (!requestedThreadId) return await this.#startThread(request, cwd);

    try {
      return await this.#resumeThread(requestedThreadId);
    } catch (error) {
      if (!isUnavailableThreadResume(error)) throw error;

      // No turn has started yet, so replacing a missing local thread cannot
      // duplicate provider or tool side effects. The caller persists the new ID.
      process.stderr.write("codex.thread_resume=stale_reset\n");
      return await this.#startThread(request, cwd);
    }
  }

  async #startThread(request: AgentRunRequest, cwd: string): Promise<string> {
    // Keep thread bootstrap capability-neutral. The real approval and sandbox
    // ceiling is applied immediately before every turn via turn/start below.
    // This avoids app-server's thread/start project-trust/config mutation path
    // while preserving one-turn-at-a-time FLORAL authorization semantics.
    const systemAwarenessEnabled = this.#systemTools.enabled;
    const params: Record<string, unknown> = {
      cwd,
      developerInstructions: systemAwarenessEnabled
        ? `${this.#developerInstructions}\n${FLORAL_SYSTEM_DEVELOPER_INSTRUCTIONS}`
        : this.#developerInstructions,
      dynamicTools: systemAwarenessEnabled
        ? [...FLORAL_DYNAMIC_TOOLS, ...FLORAL_SYSTEM_DYNAMIC_TOOLS]
        : FLORAL_DYNAMIC_TOOLS,
    };
    const model = request.model ?? this.#defaultModel;
    if (model) params.model = model;

    const response = await this.#client.request<ThreadResponse>("thread/start", params);
    if (!response.thread?.id) {
      throw codexProtocolError("thread/start returned no thread id");
    }
    this.#loadedThreads.add(response.thread.id);
    return response.thread.id;
  }

  async #resumeThread(threadId: string): Promise<string> {
    if (this.#loadedThreads.has(threadId)) return threadId;

    // Resuming only restores conversation history. Current approval/sandbox
    // policy is always re-applied by the following turn/start request.
    const systemAwarenessEnabled = this.#systemTools.enabled;
    const response = await this.#client.request<ThreadResponse>("thread/resume", {
      threadId,
      developerInstructions: systemAwarenessEnabled
        ? `${this.#developerInstructions}\n${FLORAL_SYSTEM_DEVELOPER_INSTRUCTIONS}`
        : this.#developerInstructions,
    });
    const resumedId = response.thread?.id;
    if (!resumedId) {
      throw codexProtocolError("thread/resume returned no thread id");
    }
    if (resumedId !== threadId) {
      throw codexProtocolError(`thread/resume returned ${resumedId}, expected ${threadId}`);
    }
    this.#loadedThreads.add(threadId);
    return threadId;
  }

  async #handleServerRequest(request: CodexServerRequest): Promise<void> {
    const params = asRecord(request.params);
    const threadId = readString(params?.threadId);
    const onEvent = threadId ? this.#eventHandlers.get(threadId) : undefined;

    if (request.method === "currentTime/read") {
      this.#respondSafely(request.id, { currentTimeAt: Math.floor(Date.now() / 1_000) });
      return;
    }

    if (request.method === "item/tool/call") {
      const namespace = readString(asPlainRecord(request.params)?.namespace);
      if (namespace === "floral_delivery") {
        await this.#handleArtifactDynamicToolCall(request);
        return;
      }
      if (namespace === "floral_skills") {
        await this.#handleSkillDynamicToolCall(request);
        return;
      }
      if (namespace === "floral_extensions") {
        await this.#handleExtensionDynamicToolCall(request);
        return;
      }
      if (namespace === "floral_context") {
        await this.#handleContextDynamicToolCall(request);
        return;
      }
      if (namespace === "floral_goal") {
        await this.#handleGoalDynamicToolCall(request);
        return;
      }
      if (namespace === "floral_system") {
        await this.#handleSystemDynamicToolCall(request);
        return;
      }
      this.#respondSafely(
        request.id,
        dynamicToolResponse(
          false,
          "floral_dynamic_tool=denied\nreason=unsupported-namespace",
        ),
      );
      return;
    }

    if (
      request.method === "item/commandExecution/requestApproval"
      || request.method === "item/fileChange/requestApproval"
    ) {
      if (
        request.method === "item/commandExecution/requestApproval"
        && isGuiAutomationShellBypass(readString(params?.command))
      ) {
        process.stderr.write("codex.gui_shell_bypass=declined\n");
        this.#respondSafely(request.id, { decision: "decline" });
        return;
      }
      if (
        request.method === "item/commandExecution/requestApproval"
        && threadId
        && this.#extensionMutationPendingVerification.has(threadId)
        && isExtensionVerificationShellBypass(readString(params?.command))
      ) {
        this.#extensionVerificationShellSoftBlocked.add(threadId);
        process.stderr.write("codex.extension_shell_verification=soft-blocked\n");
        this.#respondSafely(request.id, { decision: "decline" });
        return;
      }

      const itemId = readString(params?.itemId);
      const itemSummary = threadId && itemId
        ? this.#approvalItemSummaries.get(approvalItemKey(threadId, itemId))
        : undefined;
      const approval = buildCodexApprovalRequest(request, itemSummary);
      onEvent?.({
        type: "approval.requested",
        requestId: approval.requestId,
        capability: approval.capability,
        kind: approval.kind,
        detail: { summary: approval.summary },
      });

      const handler = threadId ? this.#approvalHandlers.get(threadId) : undefined;
      const decision = handler
        ? await handler(approval).catch(() => "deny" as const)
        : "deny";
      this.#respondSafely(request.id, {
        decision: decision === "approve"
          ? "accept"
          : decision === "approve-session"
            ? "acceptForSession"
            : "decline",
      });
      return;
    }

    if (request.method === "item/permissions/requestApproval") {
      const permissions = readCodexRequestedPermissions(params?.permissions);
      if (!permissions) {
        this.#respondSafely(request.id, { scope: "turn", permissions: {} });
        return;
      }
      const approval = buildCodexPermissionApprovalRequest(request, permissions);
      onEvent?.({
        type: "approval.requested",
        requestId: approval.requestId,
        capability: approval.capability,
        kind: approval.kind,
        detail: { summary: approval.summary },
      });
      const handler = threadId ? this.#approvalHandlers.get(threadId) : undefined;
      const decision = handler
        ? await handler(approval).catch(() => "deny" as const)
        : "deny";
      this.#respondSafely(
        request.id,
        decision === "approve" || decision === "approve-session"
          ? {
              scope: decision === "approve-session" ? "session" : "turn",
              permissions,
            }
          : { scope: "turn", permissions: {} },
      );
      return;
    }

    if (request.method === "mcpServer/elicitation/request") {
      const serverId = readString(params?.serverName);
      const correlatedTurnId = readString(params?.turnId)
        ?? (threadId ? this.#activeTurns.get(threadId) : undefined);
      const context = threadId && correlatedTurnId && serverId
        ? this.#resolveMcpToolApprovalContext(threadId, correlatedTurnId, serverId)
        : undefined;
      const approval = buildMcpToolApprovalRequest(request, context);
      if (!approval) {
        this.#respondSafely(request.id, { action: "decline", content: null, _meta: null });
        return;
      }
      onEvent?.({
        type: "approval.requested",
        requestId: approval.requestId,
        capability: approval.capability,
        kind: approval.kind,
        detail: { summary: approval.summary },
      });
      const handler = threadId
        ? this.#mcpToolApprovalHandlers.get(threadId)
          ?? this.#approvalHandlers.get(threadId)
        : undefined;
      const decision = handler
        ? await handler(approval).catch(() => "deny" as const)
        : "deny";
      this.#respondSafely(
        request.id,
        decision === "approve" || decision === "approve-session"
          ? { action: "accept", content: {}, _meta: null }
          : { action: "decline", content: null, _meta: null },
      );
      return;
    }

    this.#respondSafely(request.id, undefined, {
      code: -32601,
      message: `FLORAL does not support interactive server request: ${request.method}`,
    });
  }

  async #handleArtifactDynamicToolCall(
    request: CodexServerRequest,
  ): Promise<void> {
    const params = asPlainRecord(request.params);
    const threadId = readString(params?.threadId);
    const turnId = readString(params?.turnId);
    const namespace = readString(params?.namespace);
    const tool = readString(params?.tool);
    const activeTurnId = threadId ? this.#activeTurns.get(threadId) : undefined;

    if (
      !threadId
      || !turnId
      || activeTurnId !== turnId
      || namespace !== "floral_delivery"
      || !tool
    ) {
      this.#respondSafely(
        request.id,
        dynamicToolResponse(false, "artifact_delivery=denied\nreason=invalid-context"),
      );
      return;
    }

    const argumentsValue = asPlainRecord(params?.arguments);
    if (!argumentsValue) {
      this.#respondSafely(
        request.id,
        dynamicToolResponse(false, "artifact_delivery=denied\nreason=invalid-arguments"),
      );
      return;
    }
    const result = await this.#artifactTools.handle({
      tool,
      arguments: argumentsValue,
      registrationHandler: this.#artifactRegistrationHandlers.get(threadId),
      deliveryHandler: this.#artifactDeliveryHandlers.get(threadId),
    });
    this.#respondSafely(
      request.id,
      dynamicToolResponse(result.success, result.text),
    );
  }

  async #handleSkillDynamicToolCall(
    request: CodexServerRequest,
  ): Promise<void> {
    const params = asPlainRecord(request.params);
    const threadId = readString(params?.threadId);
    const turnId = readString(params?.turnId);
    const tool = readString(params?.tool);
    const activeTurnId = threadId ? this.#activeTurns.get(threadId) : undefined;
    const cwd = threadId ? this.#threadCwds.get(threadId) : undefined;

    if (!threadId || !turnId || activeTurnId !== turnId || !tool || !cwd) {
      this.#respondSafely(
        request.id,
        dynamicToolResponse(
          false,
          "skill_management=denied\nreason=invalid-context",
        ),
      );
      return;
    }

    const argumentsValue = asPlainRecord(params?.arguments);
    if (!argumentsValue) {
      this.#respondSafely(
        request.id,
        dynamicToolResponse(
          false,
          "skill_management=denied\nreason=invalid-arguments",
        ),
      );
      return;
    }

    if (tool === "list" || tool === "refresh") {
      const skills = await this.listSkills({
        cwd,
        forceReload: tool === "refresh",
      });
      this.#respondSafely(
        request.id,
        dynamicToolResponse(
          true,
          formatSkillCatalogForTool(
            skills,
            cwd,
            this.#protectedSkillRoots,
            this.#skillRoots,
          ),
        ),
      );
      return;
    }

    if (tool === "set_enabled") {
      const name = readManagedSkillName(argumentsValue.name);
      const enabled = argumentsValue.enabled;
      if (!name || typeof enabled !== "boolean") {
        this.#respondSafely(
          request.id,
          dynamicToolResponse(
            false,
            "skill_config=denied\nreason=invalid-arguments",
          ),
        );
        return;
      }

      const skills = await this.listSkills({
        cwd,
        forceReload: true,
      });
      const selected = skills.find((skill) => skill.name === name);
      if (!selected) {
        this.#respondSafely(
          request.id,
          dynamicToolResponse(
            false,
            "skill_config=denied\nreason=skill-not-found",
          ),
        );
        return;
      }
      if (
        selected.scope === "system"
        || selected.scope === "admin"
        || this.#protectedSkillRoots.some((root) =>
          pathIsInside(root, selected.path)
        )
      ) {
        this.#respondSafely(
          request.id,
          dynamicToolResponse(
            false,
            "skill_config=denied\nreason=builtin-or-managed",
          ),
        );
        return;
      }

      await this.#client.request("skills/config/write", {
        path: selected.path,
        name: null,
        enabled,
      });
      this.#skillsDirty = true;
      const verified = (
        await this.listSkills({
          cwd,
          forceReload: true,
        })
      ).find((skill) => skill.name === name);

      if (!verified || verified.enabled !== enabled) {
        this.#respondSafely(
          request.id,
          dynamicToolResponse(
            false,
            "skill_config=failed\nreason=verification",
          ),
        );
        return;
      }

      this.#respondSafely(
        request.id,
        dynamicToolResponse(
          true,
          [
            "skill_config=updated",
            `name=${safeDynamicToolToken(name)}`,
            `enabled=${String(enabled)}`,
          ].join("\n"),
        ),
      );
      return;
    }

    const projectSkillResult = await this.#projectSkillTools.handle({
      tool,
      arguments: argumentsValue,
      cwd,
      callId: readString(params?.callId) ?? String(request.id),
      approvalHandler: this.#skillManagementApprovalHandlers.get(threadId),
      onApprovalRequested: (approval) => this.#eventHandlers.get(threadId)?.({
        type: "approval.requested",
        requestId: approval.requestId,
        capability: approval.capability,
        kind: approval.kind,
        detail: { summary: approval.summary },
      }),
    });
    if (projectSkillResult) {
      this.#respondSafely(
        request.id,
        dynamicToolResponse(projectSkillResult.success, projectSkillResult.text),
      );
      return;
    }

    if (tool === "external_catalog") {
      if (!this.#externalSkillCatalog) {
        this.#respondSafely(
          request.id,
          dynamicToolResponse(
            false,
            "external_skills=denied\nreason=handler-unavailable",
          ),
        );
        return;
      }
      const text = await this.#externalSkillCatalog().catch(() =>
        "external_skills.list=failed"
      );
      this.#respondSafely(
        request.id,
        dynamicToolResponse(
          !text.startsWith("external_skills.list=failed"),
          boundedDynamicToolText(text),
        ),
      );
      return;
    }

    if (tool === "manage_external") {
      const action = readExternalSkillAction(argumentsValue.action);
      const id = readExternalSkillId(argumentsValue.id);
      const ref = readOptionalExternalSkillRef(argumentsValue.ref);
      if (
        !action
        || !id
        || (argumentsValue.ref !== undefined && !ref)
        || (ref && action !== "install" && action !== "update")
        || !this.#manageExternalSkill
      ) {
        this.#respondSafely(
          request.id,
          dynamicToolResponse(
            false,
            "external_skills=denied\nreason=invalid-arguments-or-handler",
          ),
        );
        return;
      }

      const approval: AgentApprovalRequest = {
        requestId: `skill-${
          safeDynamicToolToken(
            readString(params?.callId) ?? String(request.id),
          )
        }`,
        kind: "skill-management",
        capability: extensionCapabilityForAction(action),
        summary: [
          "FLORAL Agent 请求修改共享 External Skill。",
          `action=${action}`,
          `id=${id}`,
          ...(ref ? [`ref=${ref}`] : []),
        ].join(" "),
        source: "floral",
        scope: externalSkillApprovalScope(id, action, ref),
      };
      const onEvent = this.#eventHandlers.get(threadId);
      onEvent?.({
        type: "approval.requested",
        requestId: approval.requestId,
        capability: approval.capability,
        kind: approval.kind,
        detail: { summary: approval.summary },
      });

      const approvalHandler =
        this.#skillManagementApprovalHandlers.get(threadId);
      const decision = approvalHandler
        ? await approvalHandler(approval).catch(() => "deny" as const)
        : "deny";
      if (decision !== "approve" && decision !== "approve-session") {
        this.#respondSafely(
          request.id,
          dynamicToolResponse(
            false,
            "external_skills=denied\nreason=user-approval",
          ),
        );
        return;
      }

      const result = await this.#manageExternalSkill({
        action,
        id,
        ...(ref ? { ref } : {}),
      }).catch((error) => ({
        changed: false,
        message: [
          `external_skills.${action}=failed`,
          `reason=${safeDynamicToolToken(
            error instanceof Error ? error.name : "Error",
          )}`,
        ].join("\n"),
      }));

      this.#respondSafely(
        request.id,
        dynamicToolResponse(
          !result.message.includes("=failed"),
          boundedDynamicToolText(result.message),
        ),
      );
      return;
    }

    this.#respondSafely(
      request.id,
      dynamicToolResponse(
        false,
        "skill_management=denied\nreason=unsupported-tool",
      ),
    );
  }

  async #handleSystemDynamicToolCall(
    request: CodexServerRequest,
  ): Promise<void> {
    const params = asPlainRecord(request.params);
    const threadId = readString(params?.threadId);
    const turnId = readString(params?.turnId);
    const namespace = readString(params?.namespace);
    const tool = readString(params?.tool);
    const activeTurnId = threadId ? this.#activeTurns.get(threadId) : undefined;

    if (
      !threadId
      || !turnId
      || activeTurnId !== turnId
      || namespace !== "floral_system"
      || !tool
    ) {
      this.#respondSafely(
        request.id,
        dynamicToolResponse(false, "system_awareness=unavailable\nreason=invalid-context-or-snapshot"),
      );
      return;
    }

    const argumentsValue = asPlainRecord(params?.arguments);
    if (!argumentsValue) {
      this.#respondSafely(
        request.id,
        dynamicToolResponse(false, "system_awareness=denied\nreason=invalid-arguments"),
      );
      return;
    }

    const result = await this.#systemTools.handle({
      threadId,
      tool,
      callId: readString(params?.callId) ?? String(request.id),
      arguments: argumentsValue,
      approvalHandler: this.#systemMaintenanceApprovalHandlers.get(threadId),
      maintenanceHandler: this.#systemMaintenanceHandlers.get(threadId),
      onApprovalRequested: (approval) => {
        this.#eventHandlers.get(threadId)?.({
          type: "approval.requested",
          requestId: approval.requestId,
          capability: approval.capability,
          kind: approval.kind,
          detail: { summary: approval.summary },
        });
      },
    });
    this.#respondSafely(request.id, dynamicToolResponse(result.success, result.text));
  }

  async #handleGoalDynamicToolCall(request: CodexServerRequest): Promise<void> {
    const raw = asPlainRecord(request.params);
    const threadId = readString(raw?.threadId);
    const call = readGoalDynamicCall(request.params, threadId ? this.#activeTurns.get(threadId) : undefined);
    if (!call) {
      this.#respondSafely(
        request.id,
        dynamicToolResponse(false, "goal=denied\nreason=invalid-context-or-arguments"),
      );
      return;
    }
    const result = await executeGoalDynamicTool({
      ...call,
      getGoal: async () => this.getGoal(call.threadId),
      setGoal: async (input) => this.setGoal(input),
      clearGoal: async () => this.clearGoal(call.threadId),
    });
    this.#respondSafely(request.id, dynamicToolResponse(result.success, result.text));
  }

  async #handleContextDynamicToolCall(
    request: CodexServerRequest,
  ): Promise<void> {
    const params = asPlainRecord(request.params);
    const threadId = readString(params?.threadId);
    const turnId = readString(params?.turnId);
    const tool = readString(params?.tool);
    const activeTurnId = threadId ? this.#activeTurns.get(threadId) : undefined;
    const cwd = threadId ? this.#threadCwds.get(threadId) : undefined;
    if (!threadId || !turnId || activeTurnId !== turnId || !tool || !cwd) {
      this.#respondSafely(
        request.id,
        dynamicToolResponse(false, "context_management=denied\nreason=invalid-context"),
      );
      return;
    }
    const argumentsValue = asPlainRecord(params?.arguments);
    if (!argumentsValue) {
      this.#respondSafely(
        request.id,
        dynamicToolResponse(false, "context_management=denied\nreason=invalid-arguments"),
      );
      return;
    }
    const result = await this.#contextTools.handle({
      threadId,
      cwd,
      tool,
      callId: readString(params?.callId) ?? String(request.id),
      arguments: argumentsValue,
      approvalHandler: this.#approvalHandlers.get(threadId),
      onApprovalRequested: (approval) => {
        this.#eventHandlers.get(threadId)?.({
          type: "approval.requested",
          requestId: approval.requestId,
          capability: approval.capability,
          kind: approval.kind,
          detail: { summary: approval.summary },
        });
      },
    });
    this.#respondSafely(
      request.id,
      dynamicToolResponse(result.success, result.text),
    );
  }

  async #handleExtensionDynamicToolCall(
    request: CodexServerRequest,
  ): Promise<void> {
    const params = asPlainRecord(request.params);
    const threadId = readString(params?.threadId);
    const turnId = readString(params?.turnId);
    const tool = readString(params?.tool);
    const activeTurnId = threadId ? this.#activeTurns.get(threadId) : undefined;
    const cwd = threadId ? this.#threadCwds.get(threadId) : undefined;
    if (!threadId || !turnId || activeTurnId !== turnId || !tool || !cwd) {
      this.#respondSafely(
        request.id,
        dynamicToolResponse(
          false,
          "extension_discovery=denied\nreason=invalid-context",
        ),
      );
      return;
    }

    const argumentsValue = asPlainRecord(params?.arguments);
    if (!argumentsValue) {
      this.#respondSafely(
        request.id,
        dynamicToolResponse(
          false,
          "extension_discovery=denied\nreason=invalid-arguments",
        ),
      );
      return;
    }

    try {
      const snapshot = this.#extensionSnapshots.get(threadId);
      if (!snapshot) {
        throw new Error("extension snapshot unavailable");
      }

      if (tool === "plan_extension") {
        const kind = readExtensionPlanKind(argumentsValue.kind);
        const id = readExtensionPlanTargetId(argumentsValue.id);
        const intent = readExtensionPlanIntent(argumentsValue.intent);
        const systemSnapshot = this.#systemTools.getSnapshot(threadId);
        if (!kind || !id || (argumentsValue.intent !== undefined && !intent) || !systemSnapshot) {
          this.#respondSafely(
            request.id,
            dynamicToolResponse(false, "extension_plan=denied\nreason=invalid-arguments-or-system-snapshot"),
          );
          return;
        }
        const plan = buildExtensionPlan(systemSnapshot, {
          kind,
          id,
          ...(intent ? { intent } : {}),
        });
        this.#respondSafely(
          request.id,
          dynamicToolResponse(true, boundedDynamicToolText(formatExtensionPlan(plan))),
        );
        return;
      }

      if (tool === "verify_extension") {
        const systemSnapshot = this.#systemTools.getSnapshot(threadId);
        if (!systemSnapshot) {
          this.#respondSafely(
            request.id,
            dynamicToolResponse(false, "extension_verification=denied\nreason=system-snapshot-unavailable"),
          );
          return;
        }
        const transactionId = readOptionalExtensionTransactionId(argumentsValue.transaction_id);
        if (argumentsValue.transaction_id !== undefined && !transactionId) {
          this.#respondSafely(
            request.id,
            dynamicToolResponse(false, "extension_verification=denied\nreason=invalid-transaction-id"),
          );
          return;
        }
        const transaction = readExtensionControlTransactionFromSnapshot(systemSnapshot, transactionId);
        if (!transaction) {
          this.#respondSafely(
            request.id,
            dynamicToolResponse(
              true,
              [
                "FLORAL Controlled Extension Verification",
                "status=unavailable",
                "reason=no-controlled-extension-transaction-in-frozen-snapshot",
                "execution_performed=false",
              ].join("\n"),
            ),
          );
          return;
        }
        const result = buildExtensionVerification(systemSnapshot, transaction);
        if (this.#recordExtensionVerification) {
          await this.#recordExtensionVerification(result).catch(() => undefined);
        }
        this.#respondSafely(
          request.id,
          dynamicToolResponse(true, boundedDynamicToolText(formatExtensionVerification(result))),
        );
        return;
      }

      if (tool === "extension_history") {
        const systemSnapshot = this.#systemTools.getSnapshot(threadId);
        if (!systemSnapshot) {
          this.#respondSafely(
            request.id,
            dynamicToolResponse(false, "extension_history=denied\nreason=system-snapshot-unavailable"),
          );
          return;
        }
        const limit = readOptionalHistoryLimit(argumentsValue.limit);
        if (argumentsValue.limit !== undefined && limit === undefined) {
          this.#respondSafely(request.id, dynamicToolResponse(false, "extension_history=denied\nreason=invalid-limit"));
          return;
        }
        const history = readExtensionControlTransactionsFromSnapshot(systemSnapshot)
          .slice(0, limit ?? 20);
        this.#respondSafely(
          request.id,
          dynamicToolResponse(true, boundedDynamicToolText(formatExtensionControlHistory(history))),
        );
        return;
      }

      if (tool === "apply_extension") {
        const kind = readExtensionApplyKind(argumentsValue.kind);
        const action = readExternalSkillAction(argumentsValue.action);
        const id = readExtensionPlanTargetId(argumentsValue.id);
        const systemSnapshot = this.#systemTools.getSnapshot(threadId);
        if (!kind || !action || !id || !systemSnapshot) {
          this.#respondSafely(
            request.id,
            dynamicToolResponse(false, "extension_apply=denied\nreason=invalid-arguments-or-system-snapshot"),
          );
          return;
        }
        const intent = extensionIntentForAction(action);
        const plan = buildExtensionPlan(systemSnapshot, { kind, id, intent });
        if (plan.status !== "action-required" || plan.recommendedAction !== action) {
          this.#respondSafely(
            request.id,
            dynamicToolResponse(
              false,
              boundedDynamicToolText([
                "extension_apply=denied",
                "reason=plan-does-not-authorize-requested-action",
                `plan_status=${plan.status}`,
                `requested_action=${action}`,
                `recommended_action=${plan.recommendedAction ?? "none"}`,
                `current_state=${safeDynamicToolToken(plan.currentState)}`,
                `next=${plan.verificationInterface}`,
              ].join("\n")),
            ),
          );
          return;
        }

        if (kind === "app") {
          const result = await this.#nativeExtensionTools.applyApp({
            id,
            action,
            cwd,
            threadId,
            callId: readString(params?.callId) ?? String(request.id),
            snapshot,
            approvalHandler: this.#extensionManagementApprovalHandlers.get(threadId),
            onApprovalRequested: (approval) => this.#eventHandlers.get(threadId)?.({
              type: "approval.requested",
              requestId: approval.requestId,
              capability: approval.capability,
              kind: approval.kind,
              detail: { summary: approval.summary },
            }),
          });
          if (result.mutationPending) this.#extensionMutationPendingVerification.add(threadId);
          this.#respondSafely(request.id, dynamicToolResponse(result.success, result.text));
          return;
        }

        if (kind === "mcp") {
          const mcpId = readExternalMcpId(id);
          const mcpAction = readExternalMcpAction(action);
          const handler = this.#extensionManagementApprovalHandlers.get(threadId);
          if (!mcpId || !mcpAction || !handler || !this.#manageExternalMcp) {
            this.#respondSafely(request.id, dynamicToolResponse(false, "extension_apply=denied\nreason=curated-mcp-handler-unavailable"));
            return;
          }
          const approval: AgentApprovalRequest = {
            requestId: `extension-${safeDynamicToolToken(readString(params?.callId) ?? String(request.id))}`,
            kind: "extension-management",
            capability: extensionCapabilityForAction(mcpAction),
            summary: `FLORAL Agent 请求按受控扩展计划修改 External MCP： action=${mcpAction} id=${mcpId}`,
            source: "floral",
            scope: externalMcpApprovalScope(mcpId, mcpAction),
          };
          this.#eventHandlers.get(threadId)?.({
            type: "approval.requested",
            requestId: approval.requestId,
            capability: approval.capability,
            kind: approval.kind,
            detail: { summary: approval.summary },
          });
          const decision = await handler(approval).catch(() => "deny" as const);
          if (decision !== "approve") {
            this.#respondSafely(request.id, dynamicToolResponse(false, "extension_apply=denied\nreason=user-approval"));
            return;
          }
          const result = await this.#manageExternalMcp({ action: mcpAction, id: mcpId }).catch((error) => ({
            changed: false,
            registry: { version: 1 as const, packages: [] },
            message: `external_mcp.${mcpAction}=failed reason=${safeDynamicToolToken(error instanceof Error ? error.name : "Error")}`,
          }));
          const succeeded = !result.message.includes("=failed");
          if (succeeded && result.changed) this.#extensionMutationPendingVerification.add(threadId);
          const transactionId = "transactionId" in result ? result.transactionId : undefined;
          const resultText = succeeded
            ? [
                result.message,
                ...(transactionId ? [`extension_transaction=${safeDynamicToolToken(transactionId)}`] : []),
                "verification=pending-fresh-turn",
                "verification_tool=floral_extensions/verify_extension",
                "same_turn_verification=forbidden",
                "shell_verification=forbidden",
              ].join("\n")
            : result.message;
          this.#respondSafely(request.id, dynamicToolResponse(succeeded, boundedDynamicToolText(resultText)));
          return;
        }

        const skillId = readExternalSkillId(id);
        const handler = this.#skillManagementApprovalHandlers.get(threadId);
        if (!skillId || !handler || !this.#manageExternalSkill) {
          this.#respondSafely(request.id, dynamicToolResponse(false, "extension_apply=denied\nreason=curated-skill-handler-unavailable"));
          return;
        }
        const approval: AgentApprovalRequest = {
          requestId: `skill-${safeDynamicToolToken(readString(params?.callId) ?? String(request.id))}`,
          kind: "skill-management",
          capability: extensionCapabilityForAction(action),
          summary: `FLORAL Agent 请求按受控扩展计划修改 External Skill： action=${action} id=${skillId}`,
          source: "floral",
          scope: externalSkillApprovalScope(skillId, action),
        };
        this.#eventHandlers.get(threadId)?.({
          type: "approval.requested",
          requestId: approval.requestId,
          capability: approval.capability,
          kind: approval.kind,
          detail: { summary: approval.summary },
        });
        const decision = await handler(approval).catch(() => "deny" as const);
        if (decision !== "approve") {
          this.#respondSafely(request.id, dynamicToolResponse(false, "extension_apply=denied\nreason=user-approval"));
          return;
        }
        const result = await this.#manageExternalSkill({ action, id: skillId }).catch((error) => ({
          changed: false,
          message: `external_skills.${action}=failed\nreason=${safeDynamicToolToken(error instanceof Error ? error.name : "Error")}`,
        }));
        const succeeded = !result.message.includes("=failed");
        if (succeeded && result.changed) this.#extensionMutationPendingVerification.add(threadId);
        const transactionId = "transactionId" in result ? result.transactionId : undefined;
        const resultText = succeeded
          ? [
              result.message,
              ...(transactionId ? [`extension_transaction=${safeDynamicToolToken(transactionId)}`] : []),
              "verification=pending-fresh-turn",
              "verification_tool=floral_extensions/verify_extension",
              "same_turn_verification=forbidden",
              "shell_verification=forbidden",
            ].join("\n")
          : result.message;
        this.#respondSafely(request.id, dynamicToolResponse(succeeded, boundedDynamicToolText(resultText)));
        return;
      }

      const nativeResult = await this.#nativeExtensionTools.handleRead({
        tool,
        arguments: argumentsValue,
        snapshot,
      });
      if (nativeResult) {
        this.#respondSafely(
          request.id,
          dynamicToolResponse(nativeResult.success, boundedDynamicToolText(nativeResult.text)),
        );
        return;
      }

      if (tool === "mcp_status") {
        if (this.#extensionMutationPendingVerification.has(threadId)) {
          this.#respondSafely(
            request.id,
            dynamicToolResponse(
              true,
              [
                "codex_mcp.verification=pending",
                "reason=same-turn-snapshot-predates-extension-mutation",
                "next=verify-on-next-turn",
                "verification_tool=floral_extensions/mcp_status",
                "shell_verification=forbidden",
              ].join("\n"),
            ),
          );
          return;
        }
        if (!snapshot.mcpServers) {
          throw new Error("MCP status snapshot unavailable");
        }
        this.#respondSafely(
          request.id,
          dynamicToolResponse(true, formatMcpServersForTool(snapshot.mcpServers)),
        );
        return;
      }

      if (tool === "mcp_catalog") {
        if (!this.#externalMcpCatalog) {
          throw new Error("External MCP catalog unavailable");
        }
        const text = await this.#externalMcpCatalog();
        this.#respondSafely(
          request.id,
          dynamicToolResponse(true, boundedDynamicToolText(text)),
        );
        return;
      }

      if (tool === "manage_mcp") {
        const action = readExternalMcpAction(argumentsValue.action);
        const id = readExternalMcpId(argumentsValue.id);
        const handler = this.#extensionManagementApprovalHandlers.get(threadId);
        if (!action || !id || !handler || !this.#manageExternalMcp) {
          this.#respondSafely(
            request.id,
            dynamicToolResponse(
              false,
              "external_mcp=denied\nreason=invalid-arguments-or-handler",
            ),
          );
          return;
        }

        const approval: AgentApprovalRequest = {
          requestId: `extension-${String(params?.callId ?? request.id)}`,
          kind: "extension-management",
          capability: extensionCapabilityForAction(action),
          summary: [
            "FLORAL Agent 请求修改共享 External MCP：",
            `action=${action}`,
            `id=${id}`,
          ].join(" "),
          source: "floral",
          scope: externalMcpApprovalScope(id, action),
        };
        this.#eventHandlers.get(threadId)?.({
          type: "approval.requested",
          requestId: approval.requestId,
          capability: approval.capability,
          kind: approval.kind,
          detail: { summary: approval.summary },
        });
        const decision = await handler(approval).catch(() => "deny" as const);
        if (decision !== "approve" && decision !== "approve-session") {
          this.#respondSafely(
            request.id,
            dynamicToolResponse(false, "external_mcp=denied\nreason=user-approval"),
          );
          return;
        }

        const result = await this.#manageExternalMcp({ action, id }).catch((error) => ({
          changed: false,
          registry: { version: 1 as const, packages: [] },
          message: `external_mcp.${action}=failed reason=${safeDynamicToolToken(
            error instanceof Error ? error.name : "Error",
          )}`,
        }));
        const succeeded = !result.message.includes("=failed");
        if (succeeded && result.changed) {
          this.#extensionMutationPendingVerification.add(threadId);
        }
        const resultText = succeeded && result.changed
          ? [
              result.message,
              "verification=next-turn",
              "same_turn_mcp_status_snapshot=stale",
              "verification_tool=floral_extensions/mcp_status",
              "shell_verification=forbidden",
            ].join("\n")
          : result.message;
        this.#respondSafely(
          request.id,
          dynamicToolResponse(
            succeeded,
            boundedDynamicToolText(resultText),
          ),
        );
        return;
      }
    } catch (error) {
      process.stderr.write(
        `agent.stack.extensions.read=error:${safeDynamicToolToken(
          error instanceof Error ? error.name : "Error",
        )}\n`,
      );
      this.#respondSafely(
        request.id,
        dynamicToolResponse(
          false,
          "extension_discovery=unavailable\nreason=app-server-version-or-runtime-state",
        ),
      );
      return;
    }

    this.#respondSafely(
      request.id,
      dynamicToolResponse(
        false,
        "extension_discovery=denied\nreason=unsupported-tool",
      ),
    );
  }

  #resolveMcpToolApprovalContext(
    threadId: string,
    turnId: string,
    serverId: string,
  ): InFlightMcpToolCall | undefined {
    const matches = [...this.#inFlightMcpToolCalls.values()].filter((call) =>
      call.threadId === threadId
      && call.turnId === turnId
      && call.server === serverId
      && capabilityForMcpTool(call.server, call.tool) !== undefined
    );
    // The real Codex elicitation intentionally does not carry tool_name. Only
    // correlate when exactly one capability-mapped MCP call exists for this
    // thread/turn/server. Parallel ambiguous mutations fail closed.
    return matches.length === 1 ? matches[0] : undefined;
  }

  #deleteApprovalItemSummaries(threadId: string): void {
    const prefix = `${threadId}:`;
    for (const key of this.#approvalItemSummaries.keys()) {
      if (key.startsWith(prefix)) this.#approvalItemSummaries.delete(key);
    }
  }

  #deleteInFlightMcpToolCalls(threadId: string): void {
    const prefix = `${threadId}:`;
    for (const key of this.#inFlightMcpToolCalls.keys()) {
      if (key.startsWith(prefix)) this.#inFlightMcpToolCalls.delete(key);
    }
  }

  #respondSafely(
    id: number | string,
    result?: unknown,
    error?: { code: number; message: string; data?: unknown },
  ): void {
    try {
      this.#client.respond(id, result, error);
    } catch {
      // A concurrent process-exit event or turn timeout will surface the failure.
    }
  }

  async #interruptBestEffort(threadId: string, turnId: string): Promise<void> {
    try {
      await this.#client.request("turn/interrupt", { threadId, turnId });
    } catch {
      // The original timeout/error remains the actionable failure.
    }
  }

  #ensureStarted(): void {
    if (!this.#started) {
      throw new CodexRuntimeError({
        kind: "process_exit",
        message: "CodexAppServerRuntime.start() must complete before run()",
        retryable: true,
      });
    }
  }
}


function toAppServerApprovalPolicy(
  policy: "never" | "on-request" | "untrusted",
): "never" | "on-request" | "untrusted" {
  // Codex 0.146.1 app-server accepts the config-compatible approval values
  // directly. The README example used the internal variant-style
  // "unlessTrusted", but the generated TurnStartParams schema accepts
  // "untrusted" instead.
  return policy;
}


function buildTurnSandboxPolicy(
  mode: "read-only" | "workspace-write" | "danger-full-access",
  cwd: string,
): Record<string, unknown> {
  if (mode === "danger-full-access") return { type: "dangerFullAccess" };
  if (mode === "read-only") return { type: "readOnly" };
  return {
    type: "workspaceWrite",
    writableRoots: [resolve(cwd)],
    networkAccess: false,
  };
}

function approvalItemKey(threadId: string, itemId: string): string {
  return `${threadId}:${itemId}`;
}

function summarizeApprovalItem(item: ItemLifecycleParams["item"]): string | undefined {
  if (!item) return undefined;
  if (item.type === "fileChange") {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const summaries = changes.slice(0, 8).map((change) => {
      const path = redactApprovalText(readString(change?.path)) ?? "<unknown-path>";
      const kind = redactApprovalText(readString(change?.kind));
      return kind ? `${kind}:${path}` : path;
    });
    if (summaries.length === 0) return undefined;
    const omitted = changes.length - summaries.length;
    const text = `${summaries.join(", ")}${omitted > 0 ? `, +${String(omitted)} more` : ""}`;
    return redactApprovalText(text);
  }
  if (item.type === "commandExecution") {
    const command = redactApprovalText(readString(item.command));
    const cwd = redactApprovalText(readString(item.cwd));
    if (!command) return undefined;
    return cwd ? `${command} (cwd=${cwd})` : command;
  }
  return undefined;
}

function buildCodexApprovalRequest(
  request: CodexServerRequest,
  itemSummary?: string,
): AgentApprovalRequest {
  const params = asRecord(request.params);
  const reason = redactApprovalText(readString(params?.reason));
  if (request.method === "item/fileChange/requestApproval") {
    return {
      requestId: String(request.id),
      kind: "file-change",
      capability: "files.write",
      summary: itemSummary
        ? `Codex 请求修改工作区文件：${itemSummary}${reason ? `；原因=${reason}` : ""}`
        : reason
          ? `Codex 请求修改工作区文件：${reason}`
          : "Codex 请求修改工作区文件。",
      source: "codex",
    };
  }

  const command = redactApprovalText(readString(params?.command));
  return {
    requestId: String(request.id),
    kind: "command-execution",
    capability: "shell.execute",
    summary: command
      ? `Codex 请求执行需要额外权限的命令：${command}`
      : reason
        ? `Codex 请求执行需要额外权限的命令：${reason}`
        : "Codex 请求执行一个需要额外权限的命令。",
    source: "codex",
  };
}

function buildCodexPermissionApprovalRequest(
  request: CodexServerRequest,
  permissions: Record<string, unknown>,
): AgentApprovalRequest {
  const params = asRecord(request.params);
  const reason = redactApprovalText(readString(params?.reason));
  const requested = redactApprovalText(JSON.stringify(permissions));
  const detail = requested
    ? `请求权限=${requested}${reason ? `；原因=${reason}` : ""}`
    : reason
      ? `原因=${reason}`
      : "请求结构化 filesystem/network 权限";
  return {
    requestId: String(request.id),
    kind: "permission-request",
    capability: "codex.permission.grant",
    summary: `Codex 请求扩大当前权限：${detail}`,
    source: "codex",
  };
}

function readCodexRequestedPermissions(
  value: unknown,
): Record<string, unknown> | undefined {
  const profile = asPlainRecord(value);
  if (!profile) return undefined;
  const keys = Object.keys(profile);
  if (keys.some((key) => key !== "network" && key !== "fileSystem")) {
    return undefined;
  }

  const output: Record<string, unknown> = {};

  if (profile.network !== undefined && profile.network !== null) {
    const network = asPlainRecord(profile.network);
    if (!network) return undefined;
    if (Object.keys(network).some((key) => key !== "enabled")) return undefined;
    if (network.enabled !== undefined && typeof network.enabled !== "boolean") {
      return undefined;
    }
    output.network = {
      ...(typeof network.enabled === "boolean" ? { enabled: network.enabled } : {}),
    };
  }

  if (profile.fileSystem !== undefined && profile.fileSystem !== null) {
    const fileSystem = asPlainRecord(profile.fileSystem);
    if (!fileSystem) return undefined;
    const allowed = new Set(["read", "write", "globScanMaxDepth", "entries"]);
    if (Object.keys(fileSystem).some((key) => !allowed.has(key))) return undefined;

    const normalized: Record<string, unknown> = {};
    for (const key of ["read", "write"] as const) {
      const entry = fileSystem[key];
      if (entry === undefined) continue;
      if (entry === null) {
        normalized[key] = null;
        continue;
      }
      if (!Array.isArray(entry) || !entry.every((item) => typeof item === "string")) {
        return undefined;
      }
      normalized[key] = [...entry];
    }

    const globScanMaxDepth = fileSystem.globScanMaxDepth;
    if (globScanMaxDepth !== undefined) {
      if (
        typeof globScanMaxDepth !== "number"
        || !Number.isInteger(globScanMaxDepth)
        || globScanMaxDepth < 1
      ) {
        return undefined;
      }
      normalized.globScanMaxDepth = globScanMaxDepth;
    }

    if (fileSystem.entries !== undefined) {
      if (!Array.isArray(fileSystem.entries) || !isJsonSafe(fileSystem.entries)) {
        return undefined;
      }
      normalized.entries = structuredClone(fileSystem.entries);
    }
    output.fileSystem = normalized;
  }

  return output;
}

function isJsonSafe(value: unknown, depth = 0): boolean {
  if (depth > 16) return false;
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.length <= 512 && value.every((item) => isJsonSafe(item, depth + 1));
  }
  const record = asPlainRecord(value);
  if (!record || Object.keys(record).length > 64) return false;
  return Object.values(record).every((item) => isJsonSafe(item, depth + 1));
}

function buildMcpToolApprovalRequest(
  request: CodexServerRequest,
  context: InFlightMcpToolCall | undefined,
): AgentApprovalRequest | undefined {
  const params = asRecord(request.params);
  const mode = readString(params?.mode);
  if (mode !== "form" && mode !== "openai/form") return undefined;
  const metadata = asPlainRecord(params?._meta);
  if (readString(metadata?.codex_approval_kind) !== "mcp_tool_call") return undefined;

  const serverId = readString(params?.serverName);
  if (!context || !serverId || serverId !== context.server) return undefined;
  const toolName = context.tool;
  const schema = asPlainRecord(params?.requestedSchema);
  const properties = asPlainRecord(schema?.properties);
  if (schema?.type !== "object" || !properties || Object.keys(properties).length !== 0) {
    return undefined;
  }

  const capability = capabilityForMcpTool(serverId, toolName);
  if (!capability) return undefined;
  const toolParams = asPlainRecord(metadata?.tool_params);
  if (!toolParams) return undefined;

  if (serverId === "floral_peekaboo") {
    if (
      toolName !== "click"
      || capability !== "application.control"
      || !sameMcpClickApprovalArguments(toolParams, context.arguments)
    ) {
      return undefined;
    }
    const intent = redactApprovalText(readString(context.arguments.intent));
    return {
      requestId: String(request.id),
      kind: "mcp-tool",
      capability,
      summary: intent
        ? `MCP ${serverId}/${toolName} 请求执行一次操作：${intent}`
        : `MCP ${serverId}/${toolName} 请求执行一次 ${capability} 操作。`,
      source: "mcp",
      mcpServerId: serverId,
      mcpToolName: toolName,
    };
  }

  if (
    !isCuratedExternalMcpServer(serverId)
    || !sameJsonSafeObject(toolParams, context.arguments)
  ) {
    return undefined;
  }
  const detail = redactApprovalText(
    readString(context.arguments.intent)
      ?? readString(context.arguments.reason)
      ?? readString(context.arguments.url),
  );
  return {
    requestId: String(request.id),
    kind: "mcp-tool",
    capability,
    summary: detail
      ? `MCP ${serverId}/${toolName} 请求执行 ${capability}：${detail}`
      : `MCP ${serverId}/${toolName} 请求执行一次 ${capability} 操作。`,
    source: "mcp",
    mcpServerId: serverId,
    mcpToolName: toolName,
    ...(serverId === "github-owner"
      ? { scope: buildGithubMcpApprovalScope(serverId, toolName, context.arguments) }
      : {}),
  };
}

function sameMcpClickApprovalArguments(
  metadataArguments: Record<string, unknown>,
  lifecycleArguments: Record<string, unknown>,
): boolean {
  const expectedKeys = ["intent", "on", "snapshot"];
  const metadataKeys = Object.keys(metadataArguments).sort();
  const lifecycleKeys = Object.keys(lifecycleArguments).sort();
  if (JSON.stringify(metadataKeys) !== JSON.stringify(expectedKeys)) return false;
  if (JSON.stringify(lifecycleKeys) !== JSON.stringify(expectedKeys)) return false;
  return expectedKeys.every((key) =>
    readString(metadataArguments[key]) === readString(lifecycleArguments[key])
  );
}

function sameJsonSafeObject(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  if (!isJsonSafe(left) || !isJsonSafe(right)) return false;
  return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  const record = asPlainRecord(value);
  if (record) {
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(record[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function redactApprovalText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value
    .replace(/[\u0000-\u001F\u007F]+/gu, " ")
    .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s]+/giu, "$1=<redacted>")
    .replace(/(--?(?:api[_-]?key|token|secret|password))\s+(?!<redacted>)[^\s]+/giu, "$1 <redacted>")
    .replace(/\bbearer\s+[A-Za-z0-9._~+\/=-]+/giu, "Bearer <redacted>")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) return undefined;
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 237)}...`;
}

function isExtensionVerificationShellBypass(command: string | undefined): boolean {
  if (!command) return false;
  const normalized = command.toLowerCase().replace(/\s+/gu, " ");
  const extensionMarkers = [
    ".codex",
    "external-mcp",
    "chrome-devtools",
    "chrome_devtools",
    "devtools-mcp",
    "github-mcp",
    "github_mcp",
    "codex mcp",
    "codex plugin",
    "codex plugins",
  ];
  return extensionMarkers.some((marker) => normalized.includes(marker));
}

function isUnavailableThreadResume(error: unknown): boolean {
  if (!(error instanceof CodexRuntimeError)) return false;
  if (error.method !== "thread/resume") return false;

  // Codex currently overloads JSON-RPC -32600 for both genuinely stale
  // rollouts and unrelated failures such as malformed configuration. Only
  // reset the persisted thread when the bounded server message actually says
  // the rollout/thread is unavailable; otherwise preserve the original error.
  const message = error.message.toLowerCase();
  return message.includes("thread not loaded")
    || message.includes("thread not found")
    || message.includes("no rollout found");
}

function readInFlightMcpToolCall(
  params: ItemLifecycleParams,
  fallbackThreadId: string,
): InFlightMcpToolCall | undefined {
  const item = params.item;
  if (
    item?.type !== "mcpToolCall"
    || typeof item.id !== "string"
    || typeof item.server !== "string"
    || typeof item.tool !== "string"
    || capabilityForMcpTool(item.server, item.tool) === undefined
  ) {
    return undefined;
  }
  const turnId = readString(params.turnId);
  const argumentsValue = asPlainRecord(item.arguments);
  if (!turnId || !argumentsValue) return undefined;
  return {
    threadId: readString(params.threadId) ?? fallbackThreadId,
    turnId,
    itemId: item.id,
    server: item.server,
    tool: item.tool,
    arguments: argumentsValue,
  };
}

function readRegisteredMcpArtifact(
  item: ItemLifecycleParams["item"],
): AgentArtifact | undefined {
  if (
    item?.type !== "mcpToolCall"
    || item.server !== "floral_peekaboo"
    || (item.tool !== "image" && item.tool !== "see")
    || (item.error !== undefined && item.error !== null)
  ) {
    return undefined;
  }

  const result = asPlainRecord(item.result);
  const content = Array.isArray(result?.content) ? result.content : [];
  const texts = content.flatMap((entry) => {
    const block = asPlainRecord(entry);
    return block?.type === "text" && typeof block.text === "string"
      ? [block.text]
      : [];
  });
  const artifactId = readUniqueTaggedLine(texts, "artifactId");
  const artifactPath = readUniqueTaggedLine(texts, "artifactPath");
  if (
    !artifactId
    || !artifactPath
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/u.test(artifactId)
  ) {
    return undefined;
  }

  return {
    id: artifactId,
    kind: "image",
    localPath: artifactPath,
    source: {
      type: "mcp",
      serverId: item.server,
      toolName: item.tool,
    },
  };
}

function readUniqueTaggedLine(texts: string[], key: string): string | undefined {
  const prefix = `${key}=`;
  const matches: string[] = [];
  for (const text of texts) {
    for (const line of text.split(/\r?\n/u)) {
      if (!line.startsWith(prefix)) continue;
      const value = line.slice(prefix.length).trim();
      if (value) matches.push(value);
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
}

function readMcpToolEvent(
  item: ItemLifecycleParams["item"],
): { name: string; detail: Record<string, unknown> } | undefined {
  if (
    item?.type !== "mcpToolCall"
    || typeof item.server !== "string"
    || typeof item.tool !== "string"
  ) {
    return undefined;
  }

  return {
    name: `${item.server}/${item.tool}`,
    detail: {
      server: item.server,
      tool: item.tool,
      status: item.status ?? "unknown",
      ...(item.error !== undefined ? { error: item.error } : {}),
    },
  };
}

function normalizeSkillScope(value: unknown): AgentSkillSummary["scope"] | undefined {
  return value === "user" || value === "repo" || value === "system" || value === "admin"
    ? value
    : undefined;
}

function extractExplicitSkillNames(text: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const pattern = /(?:^|\s)\$([a-z0-9][a-z0-9:-]{0,127})(?=\s|$|[.,!?;])/giu;
  for (const match of text.matchAll(pattern)) {
    const name = match[1]?.toLowerCase();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

function matchesTurn(
  params: { threadId?: string; turnId?: string },
  threadId: string,
  turnId: string | undefined,
): boolean {
  if (params.threadId && params.threadId !== threadId) return false;
  if (turnId && params.turnId && params.turnId !== turnId) return false;
  return true;
}

function readTextDelta(value: AgentDeltaParams): string | undefined {
  if (typeof value.delta === "string") return value.delta;
  if (typeof value.text === "string") return value.text;
  return undefined;
}

function readFinalAgentText(items: unknown[] | undefined): string | undefined {
  if (!items) return undefined;

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = asRecord(items[index]);
    if (
      item?.type === "agentMessage"
      && item.phase === "final_answer"
      && typeof item.text === "string"
    ) {
      return item.text;
    }
  }

  // Some app-server builds omit `phase`. In that case only an agent message
  // that occurs after the most recent work item may be treated as final. A
  // pre-tool narrative must never survive as the terminal answer.
  let candidate: string | undefined;
  for (const value of items) {
    const item = asRecord(value);
    if (!item) continue;
    if (isAgentWorkItem(item)) {
      candidate = undefined;
      continue;
    }
    if (
      item.type === "agentMessage"
      && item.phase !== "commentary"
      && typeof item.text === "string"
    ) {
      candidate = item.text;
    }
  }
  return candidate;
}

function isAgentWorkItem(
  item: ItemLifecycleParams["item"] | Record<string, unknown> | undefined,
): boolean {
  const type = item?.type;
  if (typeof type !== "string" || type.length === 0) return false;
  return !new Set([
    "agentMessage",
    "reasoning",
    "plan",
    "userMessage",
  ]).has(type);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

function asPlainRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isGuiAutomationShellBypass(command: string | undefined): boolean {
  if (!command) return false;
  const normalized = command.toLowerCase();
  if (/\bosascript\b/u.test(normalized) || /\bcliclick\b/u.test(normalized)) {
    return true;
  }
  return /\bpeekaboo\b[\s\S]{0,240}\b(click|type|press|scroll|hotkey|drag|paste|move|swipe)\b/u
    .test(normalized);
}

function normalizeSkillRoots(roots: readonly string[]): string[] {
  return [...new Set(
    roots
      .map((root) => root.trim())
      .filter(Boolean)
      .map((root) => resolve(root)),
  )];
}

function pathIsInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === ""
    || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function readManagedSkillName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/u.test(name)
    ? name
    : undefined;
}

function readExternalSkillAction(
  value: unknown,
): ExternalSkillMutationRequest["action"] | undefined {
  return value === "install"
    || value === "update"
    || value === "enable"
    || value === "disable"
    || value === "remove"
    ? value
    : undefined;
}

function readExternalSkillId(value: unknown): ExternalSkillCatalogId | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim();
  return /^[a-z0-9][a-z0-9-]{0,63}$/u.test(id)
      && id in CURATED_EXTERNAL_SKILLS
    ? id as ExternalSkillCatalogId
    : undefined;
}

function readOptionalExtensionTransactionId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toUpperCase();
  return /^[A-Z0-9]{8,24}$/u.test(normalized) ? normalized : undefined;
}

function readOptionalHistoryLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 50
    ? value as number
    : undefined;
}

function readOptionalExternalSkillRef(
  value: unknown,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return undefined;
  const ref = value.trim();
  if (
    !ref
    || ref.length > 160
    || /[\u0000-\u001F\u007F\s]/u.test(ref)
  ) {
    return undefined;
  }
  return ref;
}

function formatSkillCatalogForTool(
  skills: AgentSkillSummary[],
  cwd: string,
  protectedRoots: readonly string[],
  sharedRoots: readonly string[],
): string {
  const projectSkillRoot = resolve(cwd, ".agents", "skills");
  const externalRoots = sharedRoots.filter((root) =>
    !protectedRoots.some((protectedRoot) =>
      resolve(protectedRoot) === resolve(root)
    )
  );
  const lines = [`skill_catalog.count=${String(skills.length)}`];

  for (const skill of skills.slice(0, 200)) {
    const source = protectedRoots.some((root) =>
      pathIsInside(root, skill.path)
    )
      ? "floral-builtin"
      : pathIsInside(projectSkillRoot, skill.path)
        ? "project"
        : externalRoots.some((root) =>
            pathIsInside(root, skill.path)
          )
          ? "external"
          : skill.scope;

    lines.push([
      `name=${safeDynamicToolToken(skill.name)}`,
      `enabled=${String(skill.enabled)}`,
      `scope=${skill.scope}`,
      `source=${source}`,
    ].join(" "));
  }

  return lines.join("\n");
}

function isAppInstalledCompatibilityError(error: unknown): boolean {
  return error instanceof CodexRuntimeError
    && error.method === "app/installed"
    && (error.code === -32601 || error.code === -32602);
}

function parseMcpServerStatus(value: unknown): AgentMcpServerSummary | undefined {
  const record = asPlainRecord(value);
  if (!record) return undefined;
  const name = readBoundedPlainText(record.name ?? record.serverName, 160);
  if (!name) return undefined;
  const rawStatus = readBoundedPlainText(record.status, 80)?.toLowerCase();
  const authStatus = readBoundedPlainText(
    record.authStatus ?? record.authenticationStatus ?? readStatusScalar(record.auth),
    240,
  );
  const failureReason = readBoundedPlainText(
    record.failureReason ?? record.error,
    500,
  );
  const tools = parseMcpToolSummaries(record.tools);
  const status: AgentMcpServerSummary["status"] = rawStatus === "starting"
    || rawStatus === "ready"
    || rawStatus === "failed"
    || rawStatus === "cancelled"
    ? rawStatus
    : failureReason
      ? "failed"
      : tools.length > 0
        ? "ready"
        : "unknown";
  return {
    name,
    status,
    ...(authStatus ? { authStatus } : {}),
    ...(failureReason ? { failureReason } : {}),
    tools,
  };
}

function readStatusScalar(value: unknown): unknown {
  if (typeof value === "string") return value;
  const record = asPlainRecord(value);
  if (!record) return undefined;
  return record.status ?? record.state ?? record.type;
}

function parseMcpToolSummaries(
  value: unknown,
): AgentMcpServerSummary["tools"] {
  const output: AgentMcpServerSummary["tools"] = [];
  const append = (nameValue: unknown, detailValue: unknown) => {
    if (output.length >= 200) return;
    const detail = asPlainRecord(detailValue);
    const name = readBoundedPlainText(nameValue ?? detail?.name, 200);
    if (!name) return;
    const annotations = asPlainRecord(detail?.annotations);
    const readOnly = typeof detail?.readOnly === "boolean"
      ? detail.readOnly
      : typeof detail?.isReadOnly === "boolean"
        ? detail.isReadOnly
        : typeof annotations?.readOnlyHint === "boolean"
          ? annotations.readOnlyHint
          : undefined;
    output.push({ name, ...(readOnly !== undefined ? { readOnly } : {}) });
  };
  if (Array.isArray(value)) {
    for (const item of value) append(undefined, item);
    return output;
  }
  const record = asPlainRecord(value);
  if (!record) return output;
  for (const [name, detail] of Object.entries(record)) append(name, detail);
  return output;
}

function appendExplicitAppMentions(
  turnInput: Array<Record<string, unknown>>,
  text: string,
  apps: AgentAppSummary[],
  explicitSkillNames: ReadonlySet<string>,
): void {
  const byToken = new Map<string, AgentAppSummary>();
  for (const app of apps) {
    if (!app.enabled || app.accessible === false || app.callable === false) continue;
    byToken.set(app.id.toLowerCase(), app);
    if (app.runtimeName) byToken.set(app.runtimeName.toLowerCase(), app);
  }
  const seen = new Set<string>();
  const pattern = /(?:^|\s)\$([a-z0-9][a-z0-9_-]{0,159})(?=\s|$|[.,!?;:])/giu;
  for (const match of text.matchAll(pattern)) {
    const token = match[1]?.toLowerCase();
    if (!token || explicitSkillNames.has(token)) continue;
    const app = byToken.get(token);
    if (!app || seen.has(app.id)) continue;
    seen.add(app.id);
    turnInput.push({
      type: "mention",
      name: app.runtimeName ?? app.id,
      path: `app://${app.id}`,
    });
  }
}

function normalizeFeatureStage(
  value: unknown,
): AgentNativeFeatureSummary["stage"] {
  return value === "beta"
    || value === "underDevelopment"
    || value === "stable"
    || value === "deprecated"
    || value === "removed"
    ? value
    : "unknown";
}

function readHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > 2_048) return undefined;
  try {
    const url = new URL(normalized);
    const supportedHost = url.hostname === "chatgpt.com"
      || url.hostname.endsWith(".chatgpt.com");
    return url.protocol === "https:"
        && supportedHost
        && url.pathname.startsWith("/apps/")
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function readBoundedPlainText(
  value: unknown,
  maxLength: number,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .replace(/[\u0000-\u001F\u007F]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) return undefined;
  return Array.from(normalized).slice(0, maxLength).join("");
}

function parseAppReadResponse(response: AppReadResponse): AgentAppReadResult {
  const apps = Array.isArray(response?.apps) ? response.apps : [];
  const outputApps = apps.flatMap((app) => {
    const id = readBoundedPlainText(app?.id, 160);
    const name = readBoundedPlainText(app?.name, 200);
    if (!id || !name) return [];
    const description = readBoundedPlainText(app?.description, 1_000);
    const pluginDisplayNames = Array.isArray(app?.pluginDisplayNames)
      ? app.pluginDisplayNames.flatMap((value) => {
          const text = readBoundedPlainText(value, 200);
          return text ? [text] : [];
        }).slice(0, 50)
      : [];
    const toolSummaries = Array.isArray(app?.toolSummaries)
      ? app.toolSummaries
      : [];
    const tools: AgentAppReadResult["apps"][number]["tools"] = toolSummaries.flatMap((value) => {
      const tool = asPlainRecord(value);
      const toolName = readBoundedPlainText(tool?.name, 200);
      if (
        !toolName
        || typeof tool?.isEnabled !== "boolean"
        || typeof tool?.isReadOnly !== "boolean"
      ) {
        return [];
      }
      const title = readBoundedPlainText(tool?.title, 240);
      const toolDescription = readBoundedPlainText(tool?.description, 1_000);
      const disabledReason = readBoundedPlainText(tool?.disabledReason, 500);
      return [{
        name: toolName,
        ...(title ? { title } : {}),
        ...(toolDescription ? { description: toolDescription } : {}),
        enabled: tool.isEnabled,
        readOnly: tool.isReadOnly,
        ...(disabledReason ? { disabledReason } : {}),
      }];
    }).slice(0, 200);
    return [{
      id,
      name,
      ...(description ? { description } : {}),
      pluginDisplayNames,
      tools,
    }];
  });
  const missingAppIds = Array.isArray(response?.missingAppIds)
    ? response.missingAppIds.flatMap((value) => {
        const id = readBoundedPlainText(value, 160);
        return id ? [id] : [];
      }).slice(0, 100)
    : [];
  return { apps: outputApps, missingAppIds };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  createError: () => Error,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(createError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
