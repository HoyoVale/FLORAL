import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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
import type { AgentRuntime } from "../core/contracts.js";
import type {
  AgentEvent,
  AgentRunRequest,
  AgentRunResult,
} from "../core/types.js";
import { checkSearxng } from "../search/searxng.js";
import { createProjectDeepSeekCostGuard } from "../runtime/cost/cost-guard-factory.js";
import { ProviderActivityGate } from "../runtime/cost/provider-activity-gate.js";
import { createResponsesBridge } from "./bridge/bridge-factory.js";
import { CodexAppServerRuntime } from "./codex-app-server.js";
import { buildCodexDeepSeekConfig } from "./codex-deepseek-config.js";

interface ManagedBridge {
  start(): Promise<{ baseUrl: string }>;
  stop(): Promise<void>;
}

export interface ManagedWorkspace {
  codexHome: string;
  replaceConfig?(config: string): Promise<void>;
  cleanup(): Promise<void>;
}

interface SearchEndpoint {
  endpoint: string;
  resultCount: number;
}

export interface ManagedCodexDeepSeekDependencies {
  createToken?: (() => string) | undefined;
  checkSearch?: (() => Promise<SearchEndpoint>) | undefined;
  createBridge?: ((token: string) => ManagedBridge) | undefined;
  createWorkspace?: ((
    config: string,
    codexHome: string,
    options?: { fallbackConfig?: string | undefined },
  ) => Promise<ManagedWorkspace>) | undefined;
  createRuntime?: ((options: {
    codexHome: string;
    bridgeToken: string;
  }) => AgentRuntime) | undefined;
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

export class ManagedCodexDeepSeekRuntime implements AgentRuntime {
  readonly name = "codex-deepseek-managed";
  #runtime: AgentRuntime | undefined;
  #bridge: ManagedBridge | undefined;
  #workspace: ManagedWorkspace | undefined;
  readonly #providerActivityGate = new ProviderActivityGate();
  #starting: Promise<void> | undefined;
  #stopped = false;

  constructor(
    private readonly env: AppEnv,
    private readonly dependencies: ManagedCodexDeepSeekDependencies = {},
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
    const runtime = this.#requireRuntime();
    const releaseProviderActivity = this.#providerActivityGate.enterAgentRun();
    try {
      return await runtime.run(request, onEvent);
    } finally {
      releaseProviderActivity();
    }
  }

  async interrupt(threadId: string, turnId?: string): Promise<void> {
    const runtime = this.#requireRuntime();
    await runtime.interrupt(threadId, turnId);
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    const runtime = this.#runtime;
    const bridge = this.#bridge;
    const workspace = this.#workspace;
    this.#runtime = undefined;
    this.#bridge = undefined;
    this.#workspace = undefined;

    await runtime?.stop().catch(() => undefined);
    await bridge?.stop().catch(() => undefined);
    await workspace?.cleanup().catch(() => undefined);
  }

  async #startOnce(): Promise<void> {
    const token = this.dependencies.createToken?.()
      ?? randomBytes(32).toString("hex");
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
    let workspace = await this.#createWorkspace(
      adoption.productionConfig,
      managedCodexHome,
      adoption.fallbackConfig,
    );
    process.stderr.write("agent.stack.codex_home=persistent\n");
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
        if (workspace.replaceConfig) {
          await workspace.replaceConfig(adoption.fallbackConfig);
        } else {
          await workspace.cleanup();
          workspace = await this.#createWorkspace(
            adoption.fallbackConfig,
            managedCodexHome,
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
  ): Promise<ManagedWorkspace> {
    return await (this.dependencies.createWorkspace?.(
      config,
      codexHome,
      fallbackConfig ? { fallbackConfig } : undefined,
    ) ?? createPersistentCodexWorkspace(
      codexHome,
      config,
      fallbackConfig ? { fallbackConfig } : undefined,
    ));
  }

  #createRuntime(codexHome: string, bridgeToken: string): AgentRuntime {
    return this.dependencies.createRuntime?.({ codexHome, bridgeToken })
      ?? createCodexRuntime(this.env, codexHome, bridgeToken);
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

  #requireRuntime(): AgentRuntime {
    if (!this.#runtime) {
      throw new Error("Managed Codex runtime is not started");
    }
    return this.#runtime;
  }
}

export async function createPersistentCodexWorkspace(
  codexHome: string,
  config: string,
  options: { fallbackConfig?: string | undefined } = {},
): Promise<ManagedWorkspace> {
  const resolvedHome = resolve(codexHome);
  const configPath = join(resolvedHome, "config.toml");
  const fallbackPath = join(resolvedHome, "config.legacy-fallback.toml");

  await mkdir(resolvedHome, { recursive: true, mode: 0o700 });
  await chmod(resolvedHome, 0o700).catch(() => undefined);
  if (options.fallbackConfig) {
    await writeAtomicPrivateText(fallbackPath, options.fallbackConfig);
  } else {
    await rm(fallbackPath, { force: true });
  }
  await writeAtomicPrivateText(configPath, config);

  return {
    codexHome: resolvedHome,
    replaceConfig: async (replacement) => {
      await writeAtomicPrivateText(configPath, replacement);
    },
    cleanup: async () => {
      // Keep Codex thread/session state across FLORAL restarts, but remove the
      // short-lived bridge URL/token configuration and rollback copy once this
      // process stops.
      await Promise.all([
        rm(configPath, { force: true }),
        rm(fallbackPath, { force: true }),
      ]);
    },
  };
}

async function writeAtomicPrivateText(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
  const temporary = `${path}.tmp-${String(process.pid)}-${Date.now().toString(36)}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await chmod(temporary, 0o600).catch(() => undefined);
    await rename(temporary, path);
    await chmod(path, 0o600).catch(() => undefined);
    await syncDirectory(directory);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is not portable to every Windows filesystem. The file
    // itself has already been synced before the atomic rename.
  }
}

function errorName(error: unknown): string {
  return error instanceof Error && error.name ? error.name : "Error";
}

function createCodexRuntime(
  env: AppEnv,
  codexHome: string,
  bridgeToken: string,
): AgentRuntime {
  const processEnv: NodeJS.ProcessEnv = {
    ...process.env,
    CODEX_HOME: codexHome,
    FLORAL_BRIDGE_TOKEN: bridgeToken,
  };
  delete processEnv.DEEPSEEK_API_KEY;

  return new CodexAppServerRuntime({
    command: env.CODEX_COMMAND,
    args: env.CODEX_ARGS.split(/\s+/).filter(Boolean),
    requestTimeoutMs: env.CODEX_REQUEST_TIMEOUT_MS,
    defaultModel: env.DEEPSEEK_MODEL,
    processCwd: env.CODEX_CWD,
    processEnv,
  });
}
