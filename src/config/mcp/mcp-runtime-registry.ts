import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import type { EffectiveConfig } from "../federation/config-authority.js";
import {
  DEFAULT_MIMO_VISION_BASE_URL,
  DEFAULT_MIMO_VISION_MODEL,
  FLORAL_VISION_TOOLS,
} from "./vision/floral-vision-contract.js";

export type McpIntegrationStatus = "active" | "planned";
export type McpApprovalMode = "auto" | "prompt" | "writes" | "approve";

export type McpRuntimeEnvironmentEntry =
  | { name: string; kind: "literal"; value: string }
  | { name: string; kind: "passthrough" };

export interface McpRuntimeStdioTransport {
  type: "stdio";
  command: string;
  args: string[];
  inheritParentEnvironment: boolean;
  environment: McpRuntimeEnvironmentEntry[];
}

export interface McpRuntimeTool {
  name: string;
  enabled: boolean;
  approvalMode: McpApprovalMode;
}

export interface McpRuntimeServer {
  id: string;
  enabled: boolean;
  integrationStatus: McpIntegrationStatus;
  transport?: McpRuntimeStdioTransport | undefined;
  required?: boolean | undefined;
  startupTimeoutSec?: number | undefined;
  toolTimeoutSec?: number | undefined;
  defaultToolsApprovalMode?: McpApprovalMode | undefined;
  tools: McpRuntimeTool[];
  provider?: Record<string, string | number | boolean> | undefined;
}

export interface McpRuntimeRegistry {
  schemaVersion: 1;
  authorityVersion: 1;
  profile: string;
  servers: McpRuntimeServer[];
  registryFingerprint: string;
}

export interface FloralVisionRuntimePaths {
  repositoryRoot: string;
  serverEntrypoint: string;
  allowedRoot: string;
}

export function resolveFloralVisionRuntime(): FloralVisionRuntimePaths {
  const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const repositoryRoot = basename(moduleRoot) === "dist" ? dirname(moduleRoot) : moduleRoot;
  return {
    repositoryRoot,
    serverEntrypoint: join(repositoryRoot, "dist", "scripts", "floral-vision-mcp.js"),
    allowedRoot: join(repositoryRoot, "artifacts", "outbound", "floral_peekaboo"),
  };
}

export function buildMcpRuntimeRegistry(config: EffectiveConfig): McpRuntimeRegistry {
  const search = config.mcp.search;
  const visionRuntime = resolveFloralVisionRuntime();
  const visionTools = [...config.mcp.vision.enabled_tools].sort();
  const expectedVisionTools = [...FLORAL_VISION_TOOLS].sort();
  if (
    config.mcp.vision.enabled
    && JSON.stringify(visionTools) !== JSON.stringify(expectedVisionTools)
  ) {
    throw new Error("FLORAL vision MCP tool surface drift");
  }
  const servers: McpRuntimeServer[] = [
    {
      id: search.id,
      enabled: search.enabled,
      integrationStatus: "active",
      transport: {
        type: "stdio",
        command: search.command,
        args: [...search.command_args, search.package],
        inheritParentEnvironment: search.inherit_parent_environment,
        environment: [
          { name: "SEARXNG_URL", kind: "literal", value: config.search.service_url },
          { name: "NO_PROXY", kind: "literal", value: search.no_proxy },
        ],
      },
      required: search.required,
      startupTimeoutSec: search.startup_timeout_sec,
      toolTimeoutSec: search.tool_timeout_sec,
      defaultToolsApprovalMode: search.default_tools_approval_mode,
      tools: [...search.enabled_tools].sort().map((name) => ({
        name,
        enabled: true,
        approvalMode: search.tool_approval_mode,
      })),
      provider: {
        kind: "searxng",
        endpoint: config.search.service_url,
        safeSearch: config.search.settings.safe_search,
      },
    },
    {
      id: config.mcp.vision.id,
      enabled: config.mcp.vision.enabled,
      integrationStatus: "active",
      transport: {
        type: "stdio",
        command: process.execPath,
        args: [visionRuntime.serverEntrypoint],
        inheritParentEnvironment: config.mcp.vision.inherit_parent_environment,
        environment: [
          { name: "FLORAL_VISION_ALLOWED_ROOT", kind: "literal", value: visionRuntime.allowedRoot },
          { name: "MIMO_BASE_URL", kind: "literal", value: DEFAULT_MIMO_VISION_BASE_URL },
          { name: "MIMO_VISION_MODEL", kind: "literal", value: DEFAULT_MIMO_VISION_MODEL },
          { name: "MIMO_API_KEY", kind: "passthrough" },
        ],
      },
      required: config.mcp.vision.required,
      startupTimeoutSec: config.mcp.vision.startup_timeout_sec,
      toolTimeoutSec: config.mcp.vision.tool_timeout_sec,
      defaultToolsApprovalMode: config.mcp.vision.default_tools_approval_mode,
      tools: visionTools.map((name) => ({
        name,
        enabled: true,
        approvalMode: config.mcp.vision.tool_approval_mode,
      })),
      provider: {
        kind: "mimo-vision",
        model: DEFAULT_MIMO_VISION_MODEL,
        endpoint: DEFAULT_MIMO_VISION_BASE_URL,
        inputRoot: "floral-peekaboo-artifacts-only",
        inheritParentEnvironment: config.mcp.vision.inherit_parent_environment,
      },
    },
    {
      id: config.mcp.macos.id,
      enabled: config.mcp.macos.enabled,
      integrationStatus: "active",
      transport: {
        type: "stdio",
        command: config.macos.peekaboo_command,
        args: ["mcp"],
        inheritParentEnvironment: config.mcp.macos.inherit_parent_environment,
        environment: [
          {
            name: "PEEKABOO_ALLOW_TOOLS",
            kind: "literal",
            value: [...config.mcp.macos.enabled_tools].sort().join(","),
          },
          {
            // FLORAL/DeepSeek remains the model authority. Peekaboo observation
            // tools must not independently upload captures to an AI provider.
            name: "PEEKABOO_AI_PROVIDERS",
            kind: "literal",
            value: "",
          },
          { name: "PEEKABOO_LOG_LEVEL", kind: "literal", value: "warn" },
        ],
      },
      required: config.mcp.macos.required,
      startupTimeoutSec: config.mcp.macos.startup_timeout_sec,
      toolTimeoutSec: config.mcp.macos.tool_timeout_sec,
      defaultToolsApprovalMode: config.mcp.macos.default_tools_approval_mode,
      tools: [...config.mcp.macos.enabled_tools].sort().map((name) => ({
        name,
        enabled: true,
        approvalMode: config.mcp.macos.tool_approval_mode,
      })),
      provider: {
        kind: "peekaboo",
        profile: config.mcp.macos.profile,
        expectedVersion: config.mcp.macos.expected_version,
        aiProviders: "disabled",
        inheritParentEnvironment: config.mcp.macos.inherit_parent_environment,
      },
    },
  ];

  validateMcpRuntimeServers(servers);
  const withoutFingerprint = {
    schemaVersion: 1 as const,
    authorityVersion: 1 as const,
    profile: config.profile,
    servers,
  };
  return {
    ...withoutFingerprint,
    registryFingerprint: sha256(stableStringify(withoutFingerprint)),
  };
}

export function renderCodexMcpLines(registry: McpRuntimeRegistry): string[] {
  validateMcpRuntimeRegistry(registry);
  const lines: string[] = [];
  for (const server of registry.servers) {
    if (!server.enabled || server.integrationStatus !== "active") continue;
    const transport = requireStdioTransport(server);
    const enabledTools = server.tools.filter((tool) => tool.enabled);
    const literalEnvironment = transport.environment.filter(
      (entry): entry is Extract<McpRuntimeEnvironmentEntry, { kind: "literal" }> => entry.kind === "literal",
    );
    const passthroughEnvironment = transport.environment.filter(
      (entry) => entry.kind === "passthrough",
    );
    lines.push(
      "",
      `[mcp_servers.${tomlKey(server.id)}]`,
      `command = ${tomlString(transport.command)}`,
      `args = ${tomlArray(transport.args)}`,
    );
    if (literalEnvironment.length > 0) {
      lines.push(
        `env = { ${literalEnvironment.map((entry) => `${tomlKey(entry.name)} = ${tomlString(entry.value)}`).join(", ")} }`,
      );
    }
    if (passthroughEnvironment.length > 0) {
      lines.push(`env_vars = ${tomlArray(passthroughEnvironment.map((entry) => entry.name))}`);
    }
    lines.push(
      `enabled_tools = ${tomlArray(enabledTools.map((tool) => tool.name))}`,
      `required = ${String(requireBoolean(server.required, `${server.id}.required`))}`,
      `startup_timeout_sec = ${positiveInteger(server.startupTimeoutSec, `${server.id}.startupTimeoutSec`)}`,
      `tool_timeout_sec = ${positiveInteger(server.toolTimeoutSec, `${server.id}.toolTimeoutSec`)}`,
      `default_tools_approval_mode = ${tomlString(requireApprovalMode(server.defaultToolsApprovalMode, `${server.id}.defaultToolsApprovalMode`))}`,
    );
    for (const tool of enabledTools) {
      lines.push(
        "",
        `[mcp_servers.${tomlKey(server.id)}.tools.${tomlKey(tool.name)}]`,
        `approval_mode = ${tomlString(tool.approvalMode)}`,
      );
    }
  }
  return lines;
}

export function safeMcpRuntimeRegistryJson(
  registry: McpRuntimeRegistry,
): Record<string, unknown> {
  validateMcpRuntimeRegistry(registry);
  return {
    schemaVersion: registry.schemaVersion,
    authorityVersion: registry.authorityVersion,
    profile: registry.profile,
    registryFingerprint: registry.registryFingerprint,
    servers: registry.servers,
  };
}

export function validateMcpRuntimeRegistry(registry: McpRuntimeRegistry): void {
  if (registry.schemaVersion !== 1 || registry.authorityVersion !== 1) {
    throw new Error("Unsupported MCP runtime registry version");
  }
  if (!registry.profile.trim()) throw new Error("MCP runtime registry profile is required");
  validateMcpRuntimeServers(registry.servers);
  const { registryFingerprint: _ignored, ...withoutFingerprint } = registry;
  const expected = sha256(stableStringify(withoutFingerprint));
  if (registry.registryFingerprint !== expected) {
    throw new Error("MCP runtime registry fingerprint mismatch");
  }
}

function validateMcpRuntimeServers(servers: McpRuntimeServer[]): void {
  const ids = new Set<string>();
  for (const server of servers) {
    if (!server.id.trim()) throw new Error("MCP server id is required");
    if (ids.has(server.id)) throw new Error(`Duplicate MCP server id: ${server.id}`);
    ids.add(server.id);
    if (server.integrationStatus === "planned" && server.enabled) {
      throw new Error(`Planned MCP server cannot be enabled before an active adapter exists: ${server.id}`);
    }
    const toolNames = new Set<string>();
    for (const tool of server.tools) {
      if (!tool.name.trim()) throw new Error(`MCP tool name is required for ${server.id}`);
      if (toolNames.has(tool.name)) throw new Error(`Duplicate MCP tool ${tool.name} for ${server.id}`);
      toolNames.add(tool.name);
    }
    if (!server.enabled || server.integrationStatus !== "active") continue;
    const transport = requireStdioTransport(server);
    if (!transport.command.trim()) throw new Error(`MCP command is required for ${server.id}`);
    if (transport.args.some((argument) => !argument.trim())) {
      throw new Error(`MCP args contain an empty value for ${server.id}`);
    }
    if (transport.inheritParentEnvironment) {
      throw new Error(`MCP parent environment inheritance is forbidden for ${server.id}`);
    }
    const environmentNames = new Set<string>();
    for (const entry of transport.environment) {
      if (!entry.name.trim()) throw new Error(`MCP environment name is required for ${server.id}`);
      if (environmentNames.has(entry.name)) {
        throw new Error(`Duplicate MCP environment ${entry.name} for ${server.id}`);
      }
      environmentNames.add(entry.name);
    }
    if (server.tools.filter((tool) => tool.enabled).length === 0) {
      throw new Error(`Enabled MCP server has no enabled tools: ${server.id}`);
    }
    requireBoolean(server.required, `${server.id}.required`);
    positiveInteger(server.startupTimeoutSec, `${server.id}.startupTimeoutSec`);
    positiveInteger(server.toolTimeoutSec, `${server.id}.toolTimeoutSec`);
    requireApprovalMode(server.defaultToolsApprovalMode, `${server.id}.defaultToolsApprovalMode`);
  }
}

function requireStdioTransport(server: McpRuntimeServer): McpRuntimeStdioTransport {
  if (!server.transport || server.transport.type !== "stdio") {
    throw new Error(`Enabled MCP server requires a stdio transport: ${server.id}`);
  }
  return server.transport;
}

function requireApprovalMode(value: McpApprovalMode | undefined, name: string): McpApprovalMode {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requireBoolean(value: boolean | undefined, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(value: number | undefined, name: string): number {
  if (!Number.isInteger(value) || (value ?? 0) <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value as number;
}

function tomlKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/u.test(value) ? value : tomlString(value);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
