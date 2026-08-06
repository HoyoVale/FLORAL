import { randomBytes } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  prepareCodexConfigAdoption,
  removeCodexShadowReport,
  type CodexConfigAdoptionResult,
} from "../config/adoption/codex-shadow-adoption.js";
import type { AppEnv } from "../config/env.js";
import type { AgentRuntime } from "../core/contracts.js";
import type {
  AgentEvent,
  AgentRunRequest,
  AgentRunResult,
} from "../core/types.js";
import { checkSearxng } from "../search/searxng.js";
import { createResponsesBridge } from "./bridge/bridge-factory.js";
import { CodexAppServerRuntime } from "./codex-app-server.js";
import { buildCodexDeepSeekConfig } from "./codex-deepseek-config.js";

interface ManagedBridge {
  start(): Promise<{ baseUrl: string }>;
  stop(): Promise<void>;
}

export interface ManagedWorkspace {
  codexHome: string;
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
  createWorkspace?: ((config: string, codexHome: string) => Promise<ManagedWorkspace>) | undefined;
  createRuntime?: ((options: {
    codexHome: string;
    bridgeToken: string;
  }) => AgentRuntime) | undefined;
  prepareCodexConfig?: ((options: {
    legacyConfig: string;
    bridgeBaseUrl: string;
  }) => Promise<CodexConfigAdoptionResult>) | undefined;
  clearCodexShadowReport?: (() => Promise<void>) | undefined;
}

export class ManagedCodexDeepSeekRuntime implements AgentRuntime {
  readonly name = "codex-deepseek-managed";
  #runtime: AgentRuntime | undefined;
  #bridge: ManagedBridge | undefined;
  #workspace: ManagedWorkspace | undefined;
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
    return await runtime.run(request, onEvent);
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
      ?? createResponsesBridge(this.env, token, 0);
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
      const managedCodexHome = resolve(this.env.CODEX_MANAGED_HOME);
      const workspace = await (this.dependencies.createWorkspace?.(
        adoption.productionConfig,
        managedCodexHome,
      ) ?? createPersistentCodexWorkspace(managedCodexHome, adoption.productionConfig));
      this.#workspace = workspace;
      process.stderr.write("agent.stack.codex_home=persistent\n");

      const runtime = this.dependencies.createRuntime?.({
        codexHome: workspace.codexHome,
        bridgeToken: token,
      }) ?? createCodexRuntime(this.env, workspace.codexHome, token);
      this.#runtime = runtime;
      await runtime.start();
      process.stderr.write("agent.stack.codex=ok\n");
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
      // Shadow adoption is deliberately fail-open to the established legacy
      // generator. Phase 4.0E1 must not turn a diagnostic failure into a
      // production outage.
      return { mode: "legacy", productionConfig: legacyConfig };
    }
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
): Promise<ManagedWorkspace> {
  const resolvedHome = resolve(codexHome);
  const configPath = join(resolvedHome, "config.toml");

  await mkdir(resolvedHome, { recursive: true, mode: 0o700 });
  await chmod(resolvedHome, 0o700).catch(() => undefined);
  await writeFile(configPath, config, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(configPath, 0o600).catch(() => undefined);

  return {
    codexHome: resolvedHome,
    cleanup: async () => {
      // Keep Codex thread/session state across FLORAL restarts, but remove the
      // short-lived bridge URL/token configuration once this process stops.
      await rm(configPath, { force: true });
    },
  };
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
