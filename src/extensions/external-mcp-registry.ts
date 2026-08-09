import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Capability } from "../core/types.js";

export const EXTERNAL_MCP_REGISTRY_VERSION = 1 as const;
export const CHROME_DEVTOOLS_MCP_VERSION = "1.6.0" as const;

export type ExternalMcpCatalogId = "github-readonly" | "chrome-devtools";
export type ExternalMcpApprovalMode = "auto" | "prompt" | "writes" | "approve";

export type ExternalMcpTransport =
  | {
      type: "http";
      url: string;
      bearerTokenEnvVar?: string | undefined;
      httpHeaders?: Record<string, string> | undefined;
    }
  | {
      type: "stdio";
      command: string;
      args: string[];
      env?: Record<string, string> | undefined;
    };

export interface ExternalMcpCatalogEntry {
  id: ExternalMcpCatalogId;
  serverId: string;
  displayName: string;
  description: string;
  transport: ExternalMcpTransport;
  required: false;
  startupTimeoutSec: number;
  toolTimeoutSec: number;
  defaultToolsApprovalMode: ExternalMcpApprovalMode;
  capability: Capability;
  strictReadOnly: boolean;
  authentication: "none" | "bearer-env";
  authEnvVar?: string | undefined;
  supplyChain: string;
}

export const CURATED_EXTERNAL_MCP: Readonly<Record<ExternalMcpCatalogId, ExternalMcpCatalogEntry>> = {
  "github-readonly": {
    id: "github-readonly",
    serverId: "github",
    displayName: "GitHub MCP (read-only)",
    description: "Official GitHub remote MCP endpoint with server-enforced read-only mode.",
    transport: {
      type: "http",
      url: "https://api.githubcopilot.com/mcp/readonly",
      bearerTokenEnvVar: "GITHUB_PAT_TOKEN",
    },
    required: false,
    startupTimeoutSec: 20,
    toolTimeoutSec: 60,
    defaultToolsApprovalMode: "auto",
    capability: "web.search",
    strictReadOnly: true,
    authentication: "bearer-env",
    authEnvVar: "GITHUB_PAT_TOKEN",
    supplyChain: "github/github-mcp-server remote endpoint",
  },
  "chrome-devtools": {
    id: "chrome-devtools",
    serverId: "chrome-devtools",
    displayName: "Chrome DevTools MCP",
    description: "Pinned ChromeDevTools/chrome-devtools-mcp for headless browser inspection and controlled browser actions.",
    transport: {
      type: "stdio",
      command: "npx",
      args: [
        "-y",
        `chrome-devtools-mcp@${CHROME_DEVTOOLS_MCP_VERSION}`,
        "--slim",
        "--headless",
        "--no-usage-statistics",
        "--no-performance-crux",
      ],
      env: {
        CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1",
      },
    },
    required: false,
    startupTimeoutSec: 45,
    toolTimeoutSec: 120,
    defaultToolsApprovalMode: "writes",
    capability: "browser.submit",
    strictReadOnly: false,
    authentication: "none",
    supplyChain: `npm:chrome-devtools-mcp@${CHROME_DEVTOOLS_MCP_VERSION}`,
  },
};

export interface ExternalMcpRegistryEntry {
  id: ExternalMcpCatalogId;
  enabled: boolean;
  installedAt: string;
  updatedAt: string;
}

export interface ExternalMcpRegistry {
  version: typeof EXTERNAL_MCP_REGISTRY_VERSION;
  packages: ExternalMcpRegistryEntry[];
}

export interface ExternalMcpRegistryPaths {
  root: string;
  registryPath: string;
}

export function resolveExternalMcpRegistryPaths(
  repositoryRoot: string,
  dataDir: string,
): ExternalMcpRegistryPaths {
  const root = resolve(repositoryRoot, dataDir, "external-extensions");
  return {
    root,
    registryPath: join(root, "mcp-registry.json"),
  };
}

export async function readExternalMcpRegistry(
  paths: ExternalMcpRegistryPaths,
): Promise<ExternalMcpRegistry> {
  let raw: string;
  try {
    raw = await readFile(paths.registryPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: EXTERNAL_MCP_REGISTRY_VERSION, packages: [] };
    }
    throw error;
  }
  return parseExternalMcpRegistry(JSON.parse(raw) as unknown);
}

export async function writeExternalMcpRegistry(
  paths: ExternalMcpRegistryPaths,
  registry: ExternalMcpRegistry,
): Promise<void> {
  const normalized = parseExternalMcpRegistry(registry);
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  await chmod(paths.root, 0o700).catch(() => undefined);
  const temporary = `${paths.registryPath}.tmp-${String(process.pid)}-${Date.now().toString(36)}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await chmod(temporary, 0o600).catch(() => undefined);
    await rename(temporary, paths.registryPath);
    await chmod(paths.registryPath, 0o600).catch(() => undefined);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function externalMcpRegistryFingerprint(
  registry: ExternalMcpRegistry,
): string {
  const normalized = parseExternalMcpRegistry(registry);
  return createHash("sha256")
    .update(JSON.stringify(normalized), "utf8")
    .digest("hex");
}

export function renderExternalMcpOverlay(
  baseConfig: string,
  registry: ExternalMcpRegistry,
): string {
  const normalized = parseExternalMcpRegistry(registry);
  if (normalized.packages.length === 0) return baseConfig;
  const lines = ["", "# FLORAL external MCP overlay — machine-local, curated, no secrets stored"];

  for (const installed of normalized.packages) {
    const catalog = CURATED_EXTERNAL_MCP[installed.id];
    const header = `[mcp_servers.${tomlKey(catalog.serverId)}]`;
    if (baseConfig.includes(header)) {
      throw new Error(
        `External MCP server id collides with existing Codex config: ${catalog.serverId}`,
      );
    }
    lines.push("", header);
    if (catalog.transport.type === "http") {
      lines.push(`url = ${tomlString(catalog.transport.url)}`);
      if (catalog.transport.bearerTokenEnvVar) {
        lines.push(
          `bearer_token_env_var = ${tomlString(catalog.transport.bearerTokenEnvVar)}`,
        );
      }
      if (catalog.transport.httpHeaders) {
        lines.push(
          `http_headers = ${tomlInlineTable(catalog.transport.httpHeaders)}`,
        );
      }
    } else {
      lines.push(
        `command = ${tomlString(catalog.transport.command)}`,
        `args = ${tomlArray(catalog.transport.args)}`,
      );
      if (catalog.transport.env && Object.keys(catalog.transport.env).length > 0) {
        lines.push(`env = ${tomlInlineTable(catalog.transport.env)}`);
      }
    }
    lines.push(
      `enabled = ${String(installed.enabled)}`,
      `required = ${String(catalog.required)}`,
      `startup_timeout_sec = ${String(catalog.startupTimeoutSec)}`,
      `tool_timeout_sec = ${String(catalog.toolTimeoutSec)}`,
      `default_tools_approval_mode = ${tomlString(catalog.defaultToolsApprovalMode)}`,
    );
  }

  return `${baseConfig.trimEnd()}\n${lines.join("\n")}\n`;
}

export function externalMcpCapabilityForTool(
  serverId: string,
  _toolName: string,
): Capability | undefined {
  const entry = Object.values(CURATED_EXTERNAL_MCP).find(
    (candidate) => candidate.serverId === serverId,
  );
  return entry?.capability;
}

export function isCuratedExternalMcpServer(serverId: string): boolean {
  return Object.values(CURATED_EXTERNAL_MCP).some(
    (entry) => entry.serverId === serverId,
  );
}

function parseExternalMcpRegistry(value: unknown): ExternalMcpRegistry {
  if (!isRecord(value) || value.version !== EXTERNAL_MCP_REGISTRY_VERSION) {
    throw new Error("Unsupported external MCP registry version");
  }
  if (!Array.isArray(value.packages)) {
    throw new Error("External MCP registry packages must be an array");
  }
  const packages = value.packages.map(parseExternalMcpRegistryEntry);
  const ids = new Set<string>();
  const serverIds = new Set<string>();
  for (const entry of packages) {
    if (ids.has(entry.id)) throw new Error(`Duplicate external MCP id: ${entry.id}`);
    ids.add(entry.id);
    const serverId = CURATED_EXTERNAL_MCP[entry.id].serverId;
    if (serverIds.has(serverId)) {
      throw new Error(`Duplicate external MCP server id: ${serverId}`);
    }
    serverIds.add(serverId);
  }
  return {
    version: EXTERNAL_MCP_REGISTRY_VERSION,
    packages: packages.sort((a, b) => a.id.localeCompare(b.id)),
  };
}

function parseExternalMcpRegistryEntry(value: unknown): ExternalMcpRegistryEntry {
  if (!isRecord(value)) throw new Error("Invalid external MCP registry entry");
  const id = readCatalogId(value.id);
  if (typeof value.enabled !== "boolean") {
    throw new Error(`External MCP enabled flag is invalid for ${id}`);
  }
  return {
    id,
    enabled: value.enabled,
    installedAt: readIsoTimestamp(value.installedAt, "installedAt"),
    updatedAt: readIsoTimestamp(value.updatedAt, "updatedAt"),
  };
}

function readCatalogId(value: unknown): ExternalMcpCatalogId {
  if (typeof value !== "string" || !(value in CURATED_EXTERNAL_MCP)) {
    throw new Error(`Unknown external MCP id: ${String(value)}`);
  }
  return value as ExternalMcpCatalogId;
}

function readIsoTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`External MCP ${label} is invalid`);
  }
  return value;
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

function tomlInlineTable(values: Readonly<Record<string, string>>): string {
  return `{ ${Object.entries(values)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${tomlKey(key)} = ${tomlString(value)}`)
    .join(", ")} }`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
