import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createResponsesBridge } from "../src/agent/bridge/bridge-factory.js";
import type {
  CapturedCodexResponsesRequest,
  CodexCompatibilityCaptureArtifact,
} from "../src/agent/bridge/responses-compat.js";
import { CodexAppServerRuntime } from "../src/agent/codex-app-server.js";
import { buildCodexDeepSeekConfig } from "../src/agent/codex-deepseek-config.js";
import { CodexRuntimeError } from "../src/agent/codex-errors.js";
import { loadEnv } from "../src/config/env.js";
import { loadProjectEnv } from "../src/config/load-project-env.js";
import { checkSearxng } from "../src/search/searxng.js";

loadProjectEnv();
const env = loadEnv();
const compatibilityCaptureEnabled = process.argv.includes("--capture-compat");
const capturedCompatibilityRequests: CapturedCodexResponsesRequest[] = [];
let compatibilityCaptureError: Error | undefined;
const health = await checkSearxng(
  env.SEARXNG_URL,
  env.SEARXNG_REQUEST_TIMEOUT_MS,
);

const token = randomBytes(32).toString("hex");
const forcedToolName = "mcp__floral_search__searxng_web_search";
const forceMarker = "FLORAL_FORCE_SEARCH_TOOL_PROBE_V1";
let selectedForcedTool: string | undefined;
const bridge = createResponsesBridge(env, token, 0, {
  thinking: "disabled",
  forceToolNameOnce: forcedToolName,
  forceToolWhenInputContains: forceMarker,
  onForcedToolSelected: (name) => {
    selectedForcedTool = name;
    console.log(`probe.bridge.forced_tool_selected=${name}`);
  },
  ...(compatibilityCaptureEnabled
    ? {
        onCompatibilityRequest: (capture: CapturedCodexResponsesRequest) => {
          capturedCompatibilityRequests.push(capture);
        },
        onCompatibilityCaptureError: (error: Error) => {
          compatibilityCaptureError = error;
        },
      }
    : {}),
});
const address = await bridge.start();
const codexHome = await mkdtemp(join(tmpdir(), "floral-codex-search-"));
const observedTools = new Map<string, string>();

console.log("probe.chain=codex-app-server->floral-bridge->deepseek->mcp-searxng->searxng");
console.log(`probe.bridge_url=${address.baseUrl}`);
console.log(`probe.searxng_url=${health.endpoint}`);
console.log(`probe.searxng_results=${health.resultCount}`);
console.log(`probe.mcp_package=${env.SEARXNG_MCP_PACKAGE}`);
console.log("probe.deepseek_thinking=disabled");
console.log(`probe.forced_tool=${forcedToolName}`);

const config = buildCodexDeepSeekConfig({
  model: env.DEEPSEEK_MODEL,
  bridgeBaseUrl: address.baseUrl,
  streamIdleTimeoutMs: env.DEEPSEEK_REQUEST_TIMEOUT_MS,
  searchMcp: {
    searxngUrl: health.endpoint,
    packageSpec: env.SEARXNG_MCP_PACKAGE,
    startupTimeoutSec: env.SEARXNG_MCP_STARTUP_TIMEOUT_SEC,
    toolTimeoutSec: env.SEARXNG_MCP_TOOL_TIMEOUT_SEC,
  },
});
await writeFile(join(codexHome, "config.toml"), config, {
  encoding: "utf8",
  mode: 0o600,
});

const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
  CODEX_HOME: codexHome,
  FLORAL_BRIDGE_TOKEN: token,
};
delete childEnv.DEEPSEEK_API_KEY;

const runtime = new CodexAppServerRuntime({
  command: env.CODEX_COMMAND,
  args: env.CODEX_ARGS.split(/\s+/).filter(Boolean),
  requestTimeoutMs: Math.max(env.CODEX_REQUEST_TIMEOUT_MS, 180_000),
  defaultModel: env.DEEPSEEK_MODEL,
  processCwd: env.CODEX_CWD,
  processEnv: childEnv,
});

try {
  await runtime.start();
  console.log("probe.initialize=ok");

  const result = await runtime.run(
    {
      cwd: env.CODEX_CWD,
      model: env.DEEPSEEK_MODEL,
      text: [
        forceMarker,
        "You must use the MCP tool mcp__floral_search__searxng_web_search exactly once.",
        'Search for: site:docs.searxng.org "Search API" SearXNG',
        "After the tool returns, reply with exactly FLORAL_WEB_SEARCH_OK.",
        "Do not answer from memory and do not include any other text.",
      ].join("\n"),
    },
    (event) => {
      if (event.type === "run.started") {
        console.log(`probe.thread=${event.threadId}`);
      }
      if (event.type === "tool.started") {
        observedTools.set(event.name, "started");
        console.log(`probe.tool.started=${event.name}`);
      }
      if (event.type === "tool.completed") {
        const status = readToolStatus(event.detail);
        observedTools.set(event.name, status);
        console.log(`probe.tool.completed=${event.name}:${status}`);
      }
    },
  );

  const expectedTool = "floral_search/searxng_web_search";
  const finalText = result.finalText.trim();
  console.log(`probe.final=${JSON.stringify(finalText)}`);

  if (!selectedForcedTool) {
    console.log("probe.result=forced-tool-not-selected");
    process.exitCode = 1;
  } else if (observedTools.get(expectedTool) !== "completed") {
    console.log("probe.result=search-tool-not-completed");
    process.exitCode = 1;
  } else if (finalText !== "FLORAL_WEB_SEARCH_OK") {
    console.log("probe.result=unexpected-output");
    process.exitCode = 1;
  } else {
    console.log("probe.result=ok");
  }
} catch (error) {
  const failure = error instanceof CodexRuntimeError
    ? error
    : new CodexRuntimeError({
        kind: "unknown",
        message: error instanceof Error ? error.message : String(error),
        cause: error,
      });
  console.log(`probe.error.kind=${failure.kind}`);
  console.log(`probe.error.retryable=${failure.retryable}`);
  console.log(`probe.error.message=${failure.message}`);
  console.log("probe.result=failed");
  process.exitCode = 1;
} finally {
  await runtime.stop();
  await bridge.stop();
  if (compatibilityCaptureEnabled) {
    try {
      await writeCompatibilityCaptureArtifact();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`probe.compat.error=${message}`);
      process.exitCode = 1;
    }
  }
  await rm(codexHome, { recursive: true, force: true });
}

async function writeCompatibilityCaptureArtifact(): Promise<void> {
  if (compatibilityCaptureError) throw compatibilityCaptureError;
  if (capturedCompatibilityRequests.length < 2) {
    throw new Error(
      `Expected at least two sanitized Codex requests, captured ${capturedCompatibilityRequests.length}`,
    );
  }

  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const outputRoot = join(repositoryRoot, "artifacts", "codex-compat");
  const outputFile = join(outputRoot, "latest-capture.json");
  const artifact: CodexCompatibilityCaptureArtifact = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: {
      probe: "codex-deepseek-web-search",
      codexVersion: await readCommandVersion(env.CODEX_COMMAND),
      platform: process.platform,
      arch: process.arch,
    },
    requests: capturedCompatibilityRequests.map((request, index) => ({
      ...request,
      name: `request-${String(index + 1).padStart(2, "0")}`,
    })),
  };

  await mkdir(outputRoot, { recursive: true });
  await writeFile(outputFile, `${JSON.stringify(artifact, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log(`probe.compat.capture=${outputFile}`);
  console.log(`probe.compat.requests=${artifact.requests.length}`);
}

async function readCommandVersion(command: string): Promise<string> {
  return await new Promise<string>((resolvePromise) => {
    const child = spawn(command, ["--version"], {
      cwd: env.CODEX_CWD,
      env: process.env,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    const timer = setTimeout(() => child.kill("SIGTERM"), 5_000);

    child.stdout.on("data", (value: Buffer) => {
      bytes += value.length;
      if (bytes <= 4_096) chunks.push(value);
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolvePromise("unknown");
    });
    child.once("exit", () => {
      clearTimeout(timer);
      const version = Buffer.concat(chunks)
        .toString("utf8")
        .trim()
        .split(/\r?\n/, 1)[0];
      resolvePromise(version || "unknown");
    });
  });
}

function readToolStatus(value: unknown): string {
  if (
    typeof value === "object"
    && value !== null
    && typeof (value as Record<string, unknown>).status === "string"
  ) {
    return (value as { status: string }).status;
  }
  return "unknown";
}
