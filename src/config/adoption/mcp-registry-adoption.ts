import { createHash } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { normalizeNativeConfigText } from "../adapters/native-config-types.js";
import {
  renderCodexMcpLines,
  type McpRuntimeRegistry,
  validateMcpRuntimeRegistry,
} from "../mcp/mcp-runtime-registry.js";

export interface McpRegistryAdoptionReport {
  schemaVersion: 1;
  phase: "4.0E3";
  generatedAt: string;
  status: "active";
  effectiveFingerprint: string;
  registryFingerprint: string;
  codexMcpProjectionFingerprint: string;
  activeServerIds: string[];
  toolAllowlists: Record<string, string[]>;
  reportFingerprint: string;
}

export function createMcpRegistryAdoptionReport(input: {
  effectiveFingerprint: string;
  registry: McpRuntimeRegistry;
  codexConfig: string;
  now?: Date | undefined;
}): McpRegistryAdoptionReport {
  validateMcpRuntimeRegistry(input.registry);
  const expectedProjection = fingerprintMcpRegistryProjection(input.registry);
  const actualProjection = fingerprintCodexMcpProjection(input.codexConfig);
  if (expectedProjection !== actualProjection) {
    throw new Error("Codex MCP projection does not match the canonical MCP runtime registry");
  }
  const activeServers = input.registry.servers.filter((server) => (
    server.enabled && server.integrationStatus === "active"
  ));
  const reportWithoutFingerprint = {
    schemaVersion: 1 as const,
    phase: "4.0E3" as const,
    generatedAt: (input.now ?? new Date()).toISOString(),
    status: "active" as const,
    effectiveFingerprint: input.effectiveFingerprint,
    registryFingerprint: input.registry.registryFingerprint,
    codexMcpProjectionFingerprint: actualProjection,
    activeServerIds: activeServers.map((server) => server.id).sort(),
    toolAllowlists: Object.fromEntries(activeServers.map((server) => [
      server.id,
      server.tools.filter((tool) => tool.enabled).map((tool) => tool.name).sort(),
    ])),
  };
  return {
    ...reportWithoutFingerprint,
    reportFingerprint: sha256(stableStringify({
      ...reportWithoutFingerprint,
      generatedAt: "<generated-at>",
    })),
  };
}

export function assessMcpRegistryAdoptionReport(
  report: McpRegistryAdoptionReport,
  registry: McpRuntimeRegistry,
  currentCodexConfig: string,
): "active" | "drift" {
  validateMcpRuntimeRegistry(registry);
  if (report.registryFingerprint !== registry.registryFingerprint) return "drift";
  const expectedProjection = fingerprintMcpRegistryProjection(registry);
  const currentProjection = fingerprintCodexMcpProjection(currentCodexConfig);
  const activeServers = registry.servers.filter((server) => (
    server.enabled && server.integrationStatus === "active"
  ));
  const expectedServerIds = activeServers.map((server) => server.id).sort();
  const expectedToolAllowlists = Object.fromEntries(activeServers.map((server) => [
    server.id,
    server.tools.filter((tool) => tool.enabled).map((tool) => tool.name).sort(),
  ]));
  return report.status === "active"
    && report.codexMcpProjectionFingerprint === expectedProjection
    && currentProjection === expectedProjection
    && stableStringify(report.activeServerIds) === stableStringify(expectedServerIds)
    && stableStringify(report.toolAllowlists) === stableStringify(expectedToolAllowlists)
    ? "active"
    : "drift";
}

export function fingerprintMcpRegistryProjection(registry: McpRuntimeRegistry): string {
  validateMcpRuntimeRegistry(registry);
  return fingerprintCodexMcpProjection(`${renderCodexMcpLines(registry).join("\n")}\n`);
}

export function fingerprintCodexMcpProjection(codexConfig: string): string {
  const assignments = parseTomlAssignments(codexConfig);
  const projection = [...assignments.entries()]
    .filter(([path]) => path.startsWith("mcp_servers."))
    .sort(([left], [right]) => left.localeCompare(right));
  return sha256(stableStringify(projection));
}

export async function writeMcpRegistryAdoptionReport(
  repositoryRoot: string,
  report: McpRegistryAdoptionReport,
): Promise<string> {
  const path = mcpRegistryAdoptionReportPath(repositoryRoot);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
  const temporary = `${path}.tmp-${String(process.pid)}-${Date.now().toString(36)}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8" });
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
  return path;
}

export async function readMcpRegistryAdoptionReport(
  repositoryRoot: string,
): Promise<McpRegistryAdoptionReport | undefined> {
  const path = mcpRegistryAdoptionReportPath(repositoryRoot);
  try {
    const report = JSON.parse(await readFile(path, "utf8")) as McpRegistryAdoptionReport;
    if (!isValidReport(report)) throw new Error("Invalid MCP registry adoption report");
    const { reportFingerprint, ...withoutFingerprint } = report;
    const expected = sha256(stableStringify({
      ...withoutFingerprint,
      generatedAt: "<generated-at>",
    }));
    if (reportFingerprint !== expected) {
      throw new Error("Invalid MCP registry adoption report fingerprint");
    }
    return report;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

export async function removeMcpRegistryAdoptionReport(
  repositoryRoot: string,
): Promise<void> {
  await rm(mcpRegistryAdoptionReportPath(repositoryRoot), { force: true });
}

export function renderMcpRegistryAdoptionReport(report: McpRegistryAdoptionReport): string {
  return [
    `config.mcp_adoption.schema_version=${String(report.schemaVersion)}`,
    `config.mcp_adoption.phase=${report.phase}`,
    `config.mcp_adoption.status=${report.status}`,
    `config.mcp_adoption.effective_fingerprint=${report.effectiveFingerprint}`,
    `config.mcp_adoption.registry_fingerprint=${report.registryFingerprint}`,
    `config.mcp_adoption.codex_projection_fingerprint=${report.codexMcpProjectionFingerprint}`,
    `config.mcp_adoption.active_servers=${report.activeServerIds.join(",") || "none"}`,
    ...Object.keys(report.toolAllowlists).sort().map((id) => (
      `config.mcp_adoption.tools.${id}=${report.toolAllowlists[id]!.join(",") || "none"}`
    )),
    `config.mcp_adoption.report_fingerprint=${report.reportFingerprint}`,
    "config.mcp_adoption=ok",
    "",
  ].join("\n");
}

export function mcpRegistryAdoptionReportPath(repositoryRoot: string): string {
  return join(resolve(repositoryRoot), "data/config/adoption/mcp-registry.json");
}

function parseTomlAssignments(value: string): Map<string, string> {
  const assignments = new Map<string, string>();
  let section = "";
  for (const rawLine of normalizeNativeConfigText(value).split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const sectionMatch = /^\[([^\]]+)\]$/u.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1]!.trim();
      continue;
    }
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error(`Unsupported Codex TOML line: ${line}`);
    const key = line.slice(0, separator).trim();
    const path = section === "" ? key : `${section}.${key}`;
    if (assignments.has(path)) throw new Error(`Duplicate Codex TOML assignment: ${path}`);
    assignments.set(path, line.slice(separator + 1).trim());
  }
  return assignments;
}

function isValidReport(report: McpRegistryAdoptionReport): boolean {
  return report.schemaVersion === 1
    && report.phase === "4.0E3"
    && report.status === "active"
    && Number.isFinite(Date.parse(report.generatedAt))
    && [
      report.effectiveFingerprint,
      report.registryFingerprint,
      report.codexMcpProjectionFingerprint,
      report.reportFingerprint,
    ].every(isSha256)
    && isUniqueStringArray(report.activeServerIds)
    && isRecord(report.toolAllowlists)
    && Object.keys(report.toolAllowlists).every((id) => report.activeServerIds.includes(id))
    && Object.values(report.toolAllowlists).every(isUniqueStringArray);
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
    // Directory fsync is not portable to every Windows filesystem.
  }
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


function isUniqueStringArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every((item) => typeof item === "string" && item.trim() !== "")
    && new Set(value).size === value.length;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
