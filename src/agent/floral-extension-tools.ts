import type {
  AgentAppReadResult,
  AgentAppSummary,
  AgentMcpServerSummary,
  AgentNativeFeatureSummary,
} from "../core/contracts.js";
import type { ExternalMcpMutationRequest } from "../extensions/external-mcp-manager.js";
import type {
  ExtensionPlanIntent,
  ExtensionPlanKind,
} from "../extensions/extension-control.js";
import type { ExternalSkillMutationRequest } from "../skills/external-skill-manager.js";
import {
  boundedDynamicToolText,
  safeDynamicToolToken,
} from "./floral-tool-response.js";

export function readExternalMcpAction(
  value: unknown,
): ExternalMcpMutationRequest["action"] | undefined {
  return value === "install" || value === "enable" || value === "disable" || value === "remove"
    ? value
    : undefined;
}

export function readExternalMcpId(
  value: unknown,
): ExternalMcpMutationRequest["id"] | undefined {
  return value === "github-readonly" || value === "chrome-devtools"
    ? value
    : undefined;
}

export function readExtensionPlanKind(value: unknown): ExtensionPlanKind | undefined {
  return value === "mcp" || value === "skill" || value === "app" ? value : undefined;
}

export function readExtensionApplyKind(value: unknown): "mcp" | "skill" | undefined {
  return value === "mcp" || value === "skill" ? value : undefined;
}

export function readExtensionPlanIntent(value: unknown): ExtensionPlanIntent | undefined {
  if (value === undefined) return undefined;
  return value === "activate" || value === "update" || value === "disable" || value === "remove"
    ? value
    : undefined;
}

export function readExtensionPlanTargetId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u.test(normalized)
    ? normalized
    : undefined;
}

export function extensionIntentForAction(
  action: ExternalSkillMutationRequest["action"],
): ExtensionPlanIntent {
  if (action === "disable") return "disable";
  if (action === "remove") return "remove";
  if (action === "update") return "update";
  return "activate";
}

export function readAppId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(id) ? id : undefined;
}

export function normalizeAppIds(values: readonly string[]): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const value of values.slice(0, 100)) {
    const id = readBoundedPlainText(value, 160);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    output.push(id);
  }
  return output;
}

export function readAppIdArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    return undefined;
  }
  if (!value.every((entry) => typeof entry === "string")) return undefined;
  const normalized = normalizeAppIds(value as string[]);
  return normalized.length > 0 ? normalized : undefined;
}

export function formatMcpServersForTool(servers: AgentMcpServerSummary[]): string {
  const lines = [
    `codex_mcp.servers=${String(servers.length)}`,
    `codex_mcp.ready=${String(servers.filter((server) => server.status === "ready").length)}`,
  ];
  for (const server of servers.slice(0, 100)) {
    lines.push([
      `server=${safeDynamicToolToken(server.name)}`,
      `status=${server.status}`,
      `tools=${String(server.tools.length)}`,
      ...(server.authStatus ? [`auth=${JSON.stringify(server.authStatus)}`] : []),
      ...(server.failureReason ? [`failure=${JSON.stringify(server.failureReason)}`] : []),
    ].join(" "));
    for (const tool of server.tools.slice(0, 50)) {
      lines.push([
        `tool=${safeDynamicToolToken(tool.name)}`,
        ...(tool.readOnly !== undefined ? [`read_only=${String(tool.readOnly)}`] : []),
      ].join(" "));
    }
  }
  return boundedDynamicToolText(lines.join("\n"));
}

export function formatNativeExtensionStatus(
  features: AgentNativeFeatureSummary[],
): string {
  const byName = new Map(features.map((feature) => [feature.name, feature]));
  const format = (name: "apps" | "plugins"): string => {
    const feature = byName.get(name);
    return feature
      ? `${name}.stage=${feature.stage} ${name}.enabled=${String(feature.enabled)} ${name}.default_enabled=${String(feature.defaultEnabled)}`
      : `${name}.stage=unknown ${name}.enabled=unknown ${name}.default_enabled=unknown`;
  };
  return [
    "codex_extensions=managed",
    format("apps"),
    format("plugins"),
    "apps.discovery=app/installed+app/list-fallback+app/read",
    "apps.invocation=app-mention",
    "mcp.discovery=mcpServerStatus/list",
    "mcp.lifecycle=floral-curated+config/mcpServer/reload",
    "plugins.catalog_rpc=blocked-by-floral",
    "plugins.catalog_reason=upstream-under-development-for-production-clients",
    "plugins.install_rpc=blocked-by-floral",
    "plugins.install_surface=codex-cli-/plugins",
    "browser.availability=requires-ready-browser-mcp-on-headless-host",
  ].join("\n");
}

export function formatInstalledAppsForTool(apps: AgentAppSummary[]): string {
  const callableKnown = apps.filter((app) => app.callable !== undefined);
  const lines = [
    `codex_apps.discovered=${String(apps.length)}`,
    `codex_apps.callable_known=${String(callableKnown.length)}`,
    `codex_apps.callable=${String(callableKnown.filter((app) => app.callable === true).length)}`,
  ];
  for (const app of apps.slice(0, 100)) {
    lines.push([
      `id=${safeDynamicToolToken(app.id)}`,
      `name=${JSON.stringify(app.runtimeName ?? app.id)}`,
      `enabled=${String(app.enabled)}`,
      `callable=${app.callable === undefined ? "unknown" : String(app.callable)}`,
      `source=${app.source}`,
      ...(app.accessible !== undefined ? [`accessible=${String(app.accessible)}`] : []),
    ].join(" "));
  }
  return lines.join("\n");
}

export function formatAvailableAppsForTool(apps: AgentAppSummary[]): string {
  const lines = [`codex_apps.available=${String(apps.length)}`];
  for (const app of apps.slice(0, 100)) {
    lines.push([
      `id=${safeDynamicToolToken(app.id)}`,
      `name=${JSON.stringify(app.runtimeName ?? app.id)}`,
      `accessible=${String(app.accessible === true)}`,
      `enabled=${String(app.enabled)}`,
      `install=${app.installUrl ? "supported-handoff" : "unavailable"}`,
      ...(app.description
        ? [`description=${JSON.stringify(app.description)}`]
        : []),
    ].join(" "));
  }
  return lines.join("\n");
}

export function formatAppReadForTool(result: AgentAppReadResult): string {
  const lines = [
    `codex_apps.read=${String(result.apps.length)}`,
    `codex_apps.missing=${String(result.missingAppIds.length)}`,
  ];
  for (const app of result.apps) {
    lines.push(
      `app=${safeDynamicToolToken(app.id)} name=${JSON.stringify(app.name)} plugins=${JSON.stringify(app.pluginDisplayNames)}`,
    );
    for (const tool of app.tools.slice(0, 100)) {
      lines.push([
        `tool=${safeDynamicToolToken(tool.name)}`,
        `enabled=${String(tool.enabled)}`,
        `read_only=${String(tool.readOnly)}`,
        ...(tool.title ? [`title=${JSON.stringify(tool.title)}`] : []),
        ...(tool.disabledReason
          ? [`disabled_reason=${JSON.stringify(tool.disabledReason)}`]
          : []),
      ].join(" "));
    }
  }
  if (result.missingAppIds.length > 0) {
    lines.push(`missing_ids=${JSON.stringify(result.missingAppIds)}`);
  }
  return boundedDynamicToolText(lines.join("\n"));
}

function readBoundedPlainText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .replace(/[\u0000-\u001F\u007F]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) return undefined;
  return Array.from(normalized).slice(0, maxLength).join("");
}
