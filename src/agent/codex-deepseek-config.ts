import { CODEX_MODEL_CATALOG_PATH_PLACEHOLDER } from "../config/codex/codex-model-catalog.js";

export interface CodexDeepSeekSearchMcpOptions {
  searxngUrl: string;
  packageSpec: string;
  startupTimeoutSec: number;
  toolTimeoutSec: number;
}

export interface CodexDeepSeekConfigOptions {
  model: string;
  bridgeBaseUrl: string;
  streamIdleTimeoutMs: number;
  searchMcp?: CodexDeepSeekSearchMcpOptions | undefined;
}

export function buildCodexDeepSeekConfig(
  options: CodexDeepSeekConfigOptions,
): string {
  const lines = [
    `model = ${tomlString(options.model)}`,
    `model_provider = "floral-deepseek"`,
    `model_catalog_json = ${tomlString(CODEX_MODEL_CATALOG_PATH_PLACEHOLDER)}`,
    `model_reasoning_effort = "high"`,
    `web_search = "disabled"`,
    ``,
    `[model_providers.floral-deepseek]`,
    `name = "FLORAL DeepSeek Bridge"`,
    `base_url = ${tomlString(options.bridgeBaseUrl)}`,
    `wire_api = "responses"`,
    `env_key = "FLORAL_BRIDGE_TOKEN"`,
    `request_max_retries = 0`,
    `stream_max_retries = 0`,
    `stream_idle_timeout_ms = ${positiveInteger(options.streamIdleTimeoutMs, "streamIdleTimeoutMs")}`,
    `supports_websockets = false`,
  ];

  if (options.searchMcp) {
    const search = options.searchMcp;
    lines.push(
      ``,
      `[mcp_servers.floral_search]`,
      `command = "npx"`,
      `args = ["-y", ${tomlString(search.packageSpec)}]`,
      `env = { SEARXNG_URL = ${tomlString(search.searxngUrl)}, NO_PROXY = "127.0.0.1,localhost,::1" }`,
      `enabled_tools = ["searxng_web_search"]`,
      `required = true`,
      `startup_timeout_sec = ${positiveInteger(search.startupTimeoutSec, "startupTimeoutSec")}`,
      `tool_timeout_sec = ${positiveInteger(search.toolTimeoutSec, "toolTimeoutSec")}`,
      `default_tools_approval_mode = "approve"`,
      ``,
      `[mcp_servers.floral_search.tools.searxng_web_search]`,
      `approval_mode = "approve"`,
    );
  }

  return `${lines.join("\n")}\n`;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
