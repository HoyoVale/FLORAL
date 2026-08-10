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

export const EXTERNAL_MCP_REGISTRY_VERSION = 2 as const;
export const CHROME_DEVTOOLS_MCP_VERSION = "1.6.0" as const;

export type ExternalMcpCatalogId = "github-readonly" | "github-owner" | "chrome-devtools";
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
  sourceVersion: string;
  runtimePackage?: {
    name: string;
    version: string;
    integrity: string;
    entrypoint: string;
    args: string[];
  } | undefined;
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
    sourceVersion: "managed-endpoint-v1",
  },
  "github-owner": {
    id: "github-owner",
    serverId: "github-owner",
    displayName: "GitHub MCP (owner control plane)",
    description: "Official GitHub remote MCP with owner-scoped issue, PR, review, Actions, and repository operations. Repository commit/push/ref mutation tools are excluded by host policy.",
    transport: {
      type: "http",
      url: "https://api.githubcopilot.com/mcp/",
      bearerTokenEnvVar: "GITHUB_PAT_TOKEN",
      httpHeaders: {
        "X-MCP-Toolsets": "issues,pull_requests,actions,repos",
        "X-MCP-Exclude-Tools": "create_or_update_file,push_files,delete_file,merge_pull_request,update_pull_request_branch,create_branch,create_repository,fork_repository",
      },
    },
    required: false,
    startupTimeoutSec: 20,
    toolTimeoutSec: 60,
    defaultToolsApprovalMode: "writes",
    capability: "files.write",
    strictReadOnly: false,
    authentication: "bearer-env",
    authEnvVar: "GITHUB_PAT_TOKEN",
    supplyChain: "github/github-mcp-server remote endpoint (bounded owner profile)",
    sourceVersion: "managed-endpoint-v1",
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
    sourceVersion: CHROME_DEVTOOLS_MCP_VERSION,
    runtimePackage: {
      name: "chrome-devtools-mcp",
      version: CHROME_DEVTOOLS_MCP_VERSION,
      integrity: "sha512-VZX6f/OjQSYhy2BGGRs+y3LsrsAQAz/HwZCWKBLVyST/4r/3zjVEjjVW7gMCVbRDuspnVdcp5hQDPrQ5UFrdZw==",
      entrypoint: "node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js",
      args: [
        "--slim",
        "--headless",
        "--no-usage-statistics",
        "--no-performance-crux",
      ],
    },
  },
};

export interface ExternalMcpRegistryEntry {
  id: ExternalMcpCatalogId;
  enabled: boolean;
  installedAt: string;
  updatedAt: string;
  sourceVersion?: string | undefined;
  manifestIntegrity?: string | undefined;
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
  runtime?: {
    repositoryRoot: string;
    dataDir: string;
    nodeExecutable?: string | undefined;
  } | undefined,
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
    } else if (catalog.runtimePackage) {
      if (!runtime) {
        throw new Error(`Managed runtime package path is required for ${catalog.id}`);
      }
      const executable = resolve(
        runtime.repositoryRoot,
        runtime.dataDir,
        "external-extensions",
        "packages",
        catalog.id,
        catalog.runtimePackage.entrypoint,
      );
      lines.push(
        `command = ${tomlString(runtime.nodeExecutable ?? process.execPath)}`,
        `args = ${tomlArray([executable, ...catalog.runtimePackage.args])}`,
      );
      if (catalog.transport.env && Object.keys(catalog.transport.env).length > 0) {
        lines.push(`env = ${tomlInlineTable(catalog.transport.env)}`);
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
  toolName: string,
): Capability | undefined {
  const entry = Object.values(CURATED_EXTERNAL_MCP).find(
    (candidate) => candidate.serverId === serverId,
  );
  if (!entry) return undefined;
  if (entry.id === "github-readonly") return githubReadOnlyCapability(toolName);
  if (entry.id === "github-owner") return githubOwnerCapability(toolName);
  return chromeDevtoolsCapability(toolName);
}

const GITHUB_REPOSITORY_READ_TOOLS = new Set([
  "get_me",
  "get_file_contents",
  "get_commit",
  "get_label",
  "get_latest_release",
  "get_release_by_tag",
  "get_tag",
  "get_repository_tree",
  "list_branches",
  "list_commits",
  "list_releases",
  "list_repository_collaborators",
  "list_tags",
  "search_code",
  "search_commits",
  "search_repositories",
  "search_users",
]);

const GITHUB_ISSUE_READ_TOOLS = new Set([
  "get_issue",
  "get_issue_comments",
  "issue_read",
  "list_issue_types",
  "list_issue_fields",
  "list_issues",
  "list_labels",
  "list_sub_issues",
  "search_issues",
]);

const GITHUB_ISSUE_WRITE_TOOLS = new Set([
  "add_issue_comment",
  "add_sub_issue",
  "assign_copilot_to_issue",
  "create_issue",
  "issue_write",
  "remove_sub_issue",
  "reprioritize_sub_issue",
  "sub_issue_write",
  "update_issue",
]);

const GITHUB_PULL_REQUEST_READ_TOOLS = new Set([
  "get_pull_request",
  "get_pull_request_comments",
  "get_pull_request_diff",
  "get_pull_request_files",
  "get_pull_request_reviews",
  "get_pull_request_status",
  "list_pull_requests",
  "pull_request_read",
  "search_pull_requests",
]);

const GITHUB_PULL_REQUEST_WRITE_TOOLS = new Set([
  "add_comment_to_pending_review",
  "add_reply_to_pull_request_comment",
  "create_pending_pull_request_review",
  "create_pull_request",
  "create_pull_request_review",
  "delete_pending_pull_request_review",
  "pull_request_review_write",
  "request_copilot_review",
  "submit_pending_pull_request_review",
  "update_pull_request",
  "update_pull_request_review_comment",
]);

const GITHUB_ACTION_READ_TOOLS = new Set([
  "actions_get",
  "actions_list",
  "get_job_logs",
  "get_workflow_run",
  "get_workflow_run_logs",
  "get_workflow_run_usage",
  "list_workflow_jobs",
  "list_workflow_runs",
  "list_workflows",
]);

const GITHUB_ACTION_WRITE_TOOLS = new Set([
  "actions_run_trigger",
  "cancel_workflow_run",
  "delete_workflow_run_logs",
  "rerun_failed_jobs",
  "rerun_workflow_run",
  "run_workflow",
]);

function githubOwnerCapability(toolName: string): Capability | undefined {
  if (
    GITHUB_REPOSITORY_READ_TOOLS.has(toolName)
    || GITHUB_ISSUE_READ_TOOLS.has(toolName)
    || GITHUB_PULL_REQUEST_READ_TOOLS.has(toolName)
    || GITHUB_ACTION_READ_TOOLS.has(toolName)
  ) return "github.repository.read";
  if (GITHUB_ISSUE_WRITE_TOOLS.has(toolName)) return "github.issue.write";
  if (GITHUB_PULL_REQUEST_WRITE_TOOLS.has(toolName)) return "github.pull-request.write";
  if (GITHUB_ACTION_WRITE_TOOLS.has(toolName)) return "github.actions.run";
  return undefined;
}

function githubReadOnlyCapability(toolName: string): Capability | undefined {
  return GITHUB_REPOSITORY_READ_TOOLS.has(toolName)
    || GITHUB_ISSUE_READ_TOOLS.has(toolName)
    || GITHUB_PULL_REQUEST_READ_TOOLS.has(toolName)
    || GITHUB_ACTION_READ_TOOLS.has(toolName)
    ? "github.repository.read"
    : undefined;
}

const CHROME_INSPECTION_TOOLS = new Set([
  "get_console_message",
  "get_network_request",
  "list_console_messages",
  "list_network_requests",
  "list_pages",
  "performance_analyze_insight",
  "take_screenshot",
  "take_snapshot",
  "wait_for",
]);

const CHROME_INTERACTION_TOOLS = new Set([
  "click",
  "close_page",
  "drag",
  "emulate",
  "evaluate_script",
  "fill",
  "fill_form",
  "handle_dialog",
  "navigate_page",
  "new_page",
  "performance_start_trace",
  "performance_stop_trace",
  "press_key",
  "resize_page",
  "select_page",
  "upload_file",
]);

function chromeDevtoolsCapability(toolName: string): Capability | undefined {
  if (CHROME_INSPECTION_TOOLS.has(toolName)) return "browser.inspect";
  if (CHROME_INTERACTION_TOOLS.has(toolName)) return "browser.submit";
  return undefined;
}

export function isCuratedExternalMcpServer(serverId: string): boolean {
  return Object.values(CURATED_EXTERNAL_MCP).some(
    (entry) => entry.serverId === serverId,
  );
}

function parseExternalMcpRegistry(value: unknown): ExternalMcpRegistry {
  if (!isRecord(value) || (value.version !== 1 && value.version !== EXTERNAL_MCP_REGISTRY_VERSION)) {
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
  const catalog = CURATED_EXTERNAL_MCP[id];
  const expectedIntegrity = externalMcpCatalogManifestIntegrity(id);
  if (value.sourceVersion !== undefined && value.sourceVersion !== catalog.sourceVersion) {
    throw new Error(`External MCP source version drift for ${id}`);
  }
  if (value.manifestIntegrity !== undefined && value.manifestIntegrity !== expectedIntegrity) {
    throw new Error(`External MCP manifest integrity drift for ${id}`);
  }
  return {
    id,
    enabled: value.enabled,
    installedAt: readIsoTimestamp(value.installedAt, "installedAt"),
    updatedAt: readIsoTimestamp(value.updatedAt, "updatedAt"),
    sourceVersion: catalog.sourceVersion,
    manifestIntegrity: expectedIntegrity,
  };
}

export function externalMcpCatalogManifestIntegrity(
  id: ExternalMcpCatalogId,
): string {
  const catalog = CURATED_EXTERNAL_MCP[id];
  const manifest = {
    id: catalog.id,
    serverId: catalog.serverId,
    transport: catalog.transport,
    sourceVersion: catalog.sourceVersion,
    runtimePackage: catalog.runtimePackage ?? null,
    approval: catalog.defaultToolsApprovalMode,
    capability: catalog.capability,
    strictReadOnly: catalog.strictReadOnly,
    authentication: catalog.authentication,
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(manifest), "utf8").digest("hex")}`;
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
