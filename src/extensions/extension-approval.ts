import type {
  AgentExtensionApprovalScope,
  Capability,
  ExtensionApprovalAction,
} from "../core/types.js";
import {
  CHROME_DEVTOOLS_MCP_VERSION,
  CURATED_EXTERNAL_MCP,
  externalMcpCatalogManifestIntegrity,
  type ExternalMcpCatalogId,
} from "./external-mcp-registry.js";
import {
  CURATED_EXTERNAL_SKILLS,
  type ExternalSkillCatalogId,
} from "../skills/external-skill-registry.js";

export type ExtensionMutationCapability =
  | "extension.install"
  | "extension.update"
  | "extension.remove"
  | "extension.enable"
  | "extension.disable";

export function extensionCapabilityForAction(
  action: ExtensionApprovalAction,
): ExtensionMutationCapability {
  return `extension.${action}`;
}

export function externalMcpApprovalScope(
  id: ExternalMcpCatalogId,
  action: ExtensionApprovalAction,
): AgentExtensionApprovalScope {
  const catalog = CURATED_EXTERNAL_MCP[id];
  return {
    type: "extension",
    extensionKind: "mcp",
    targetId: id,
    action,
    sourceId: catalog.supplyChain,
    sourceVersion: id === "chrome-devtools"
      ? CHROME_DEVTOOLS_MCP_VERSION
      : "managed-endpoint-v1",
    integrity: externalMcpCatalogManifestIntegrity(id),
    permissions: mcpPermissions(id),
  };
}

export function externalSkillApprovalScope(
  id: ExternalSkillCatalogId,
  action: ExtensionApprovalAction,
  ref?: string | undefined,
): AgentExtensionApprovalScope {
  const catalog = CURATED_EXTERNAL_SKILLS[id];
  return {
    type: "extension",
    extensionKind: "skill",
    targetId: id,
    action,
    sourceId: catalog.repository,
    sourceVersion: ref ?? catalog.defaultRef,
    permissions: ["files.read"],
  };
}

export function appConfigApprovalScope(
  id: string,
  action: Extract<ExtensionApprovalAction, "enable" | "disable">,
): AgentExtensionApprovalScope {
  return {
    type: "extension",
    extensionKind: "app",
    targetId: id,
    action,
    sourceId: "codex-app-config",
    sourceVersion: "app-server-config-v1",
    permissions: [extensionCapabilityForAction(action)],
  };
}

function mcpPermissions(id: ExternalMcpCatalogId): Capability[] {
  if (id === "github-readonly") return ["github.repository.read"];
  if (id === "github-owner") {
    return [
      "github.repository.read",
      "github.issue.write",
      "github.pull-request.write",
      "github.actions.run",
    ];
  }
  return ["browser.inspect", "browser.submit"];
}
