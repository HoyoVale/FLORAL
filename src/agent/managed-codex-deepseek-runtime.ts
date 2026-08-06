import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

interface ManagedWorkspace {
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
  createWorkspace?: ((config: string) => Promise<ManagedWorkspace>) | undefined;
  createRuntime?: ((options: {
    codexHome: string;
    bridgeToken: string;
  }) => AgentRuntime) | undefined;
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

      const config = buildCodexDeepSeekConfig({
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
      const workspace = await (this.dependencies.createWorkspace?.(config)
        ?? createTemporaryCodexWorkspace(config));
      this.#workspace = workspace;

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

  #requireRuntime(): AgentRuntime {
    if (!this.#runtime) {
      throw new Error("Managed Codex runtime is not started");
    }
    return this.#runtime;
  }
}

async function createTemporaryCodexWorkspace(
  config: string,
): Promise<ManagedWorkspace> {
  const codexHome = await mkdtemp(join(tmpdir(), "floral-runtime-codex-"));
  await writeFile(join(codexHome, "config.toml"), config, {
    encoding: "utf8",
    mode: 0o600,
  });
  return {
    codexHome,
    cleanup: async () => {
      await rm(codexHome, { recursive: true, force: true });
    },
  };
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
