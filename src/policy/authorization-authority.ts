import type { AgentApprovalScope, Capability, GatewayRole } from "../core/types.js";
import type { McpRuntimeRegistry } from "../config/mcp/mcp-runtime-registry.js";
import {
  externalMcpCapabilityForTool,
  isCuratedExternalMcpServer,
} from "../extensions/external-mcp-registry.js";
import { approvalLevelFor, type ApprovalLevel } from "./approval.js";
import { roleAllows } from "./permissions.js";

export type AuthorizationSource =
  | "codex-command"
  | "codex-file-change"
  | "codex-permission-request"
  | "codex-permission-profile"
  | "mcp-tool"
  | "floral-skill"
  | "floral-extension"
  | "floral-maintenance"
  | "floral";

export interface AuthorizationRequest {
  role: GatewayRole;
  capability: Capability;
  source: AuthorizationSource;
  mcpServerId?: string | undefined;
  mcpToolName?: string | undefined;
  scope?: AgentApprovalScope | undefined;
}

export type AuthorizationDecision =
  | { status: "allow"; approvalLevel: "automatic"; reason: "automatic" }
  | {
      status: "approval-required";
      approvalLevel: "chat-confirmation" | "local-confirmation";
      reason: "policy";
    }
  | {
      status: "deny";
      approvalLevel: ApprovalLevel;
      reason:
        | "authorization-disabled"
        | "role-capability-denied"
        | "sandbox-capability-denied"
        | "mcp-tool-not-allowlisted"
        | "mcp-capability-mismatch"
        | "approval-scope-invalid"
        | "granular-permissions-not-enabled";
    };

export interface AuthorizationAuthorityOptions {
  enabled: boolean;
  sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
  allowRemoteFileChangeApproval: boolean;
  mcpRegistry: McpRuntimeRegistry;
}

export class AuthorizationAuthority {
  constructor(private readonly options: AuthorizationAuthorityOptions) {
    validateMcpCapabilityCoverage(options.mcpRegistry);
  }

  evaluate(request: AuthorizationRequest): AuthorizationDecision {
    const defaultLevel = approvalLevelFor(request.capability);
    if (!this.options.enabled) {
      return {
        status: "deny",
        approvalLevel: defaultLevel,
        reason: "authorization-disabled",
      };
    }

    if (!roleAllows(request.role, request.capability)) {
      return {
        status: "deny",
        approvalLevel: defaultLevel,
        reason: "role-capability-denied",
      };
    }

    if (request.source === "mcp-tool"
      && request.mcpServerId === "github-owner"
      && request.role !== "owner") {
      return {
        status: "deny",
        approvalLevel: defaultLevel,
        reason: "role-capability-denied",
      };
    }

    if (request.source === "mcp-tool" && !this.#mcpToolAllowed(request)) {
      return {
        status: "deny",
        approvalLevel: defaultLevel,
        reason: "mcp-tool-not-allowlisted",
      };
    }

    if (request.source === "mcp-tool") {
      const expected = capabilityForMcpTool(
        request.mcpServerId ?? "",
        request.mcpToolName ?? "",
      );
      if (expected !== request.capability) {
        return {
          status: "deny",
          approvalLevel: defaultLevel,
          reason: "mcp-capability-mismatch",
        };
      }
    }

    if (
      request.source === "mcp-tool"
      && request.mcpServerId === "github-owner"
      && request.capability !== "github.repository.read"
      && !validGithubMcpApprovalScope(request)
    ) {
      return {
        status: "deny",
        approvalLevel: defaultLevel,
        reason: "approval-scope-invalid",
      };
    }

    if (isExtensionMutationCapability(request.capability)
      && !validExtensionApprovalScope(request.capability, request.scope)) {
      return {
        status: "deny",
        approvalLevel: defaultLevel,
        reason: "approval-scope-invalid",
      };
    }

    if (request.capability === "skill.publish"
      && !validSkillPublishApprovalScope(request.scope)) {
      return {
        status: "deny",
        approvalLevel: defaultLevel,
        reason: "approval-scope-invalid",
      };
    }

    if (request.source === "codex-permission-profile") {
      return {
        status: "deny",
        approvalLevel: "local-confirmation",
        reason: "granular-permissions-not-enabled",
      };
    }

    const scopedFileChangeGrant = request.source === "codex-file-change"
      && request.capability === "files.write"
      && this.options.allowRemoteFileChangeApproval;
    const scopedPeekabooClickGrant = request.source === "mcp-tool"
      && request.capability === "application.control"
      && request.mcpServerId === "floral_peekaboo"
      && request.mcpToolName === "click";
    const scopedCodexPermissionGrant = request.source === "codex-permission-request"
      && request.capability === "codex.permission.grant";
    const scopedFloralSkillSupplyChainGrant = request.source === "floral-skill"
      && (isExtensionMutationCapability(request.capability)
        || request.capability === "skill.publish");
    const scopedFloralExtensionSupplyChainGrant = request.source === "floral-extension"
      && isExtensionMutationCapability(request.capability);
    // Host-owned bounded maintenance is governed separately from the Codex
    // turn sandbox. Crossing that sandbox ceiling is valid only for the exact
    // FLORAL maintenance source and still requires the capability's
    // Mac-local confirmation below.
    const scopedFloralMaintenanceGrant = request.source === "floral-maintenance"
      && request.capability === "system.restart";
    const scopedExternalBrowserGrant = request.source === "mcp-tool"
      && request.capability === "browser.submit"
      && Boolean(request.mcpServerId)
      && isCuratedExternalMcpServer(request.mcpServerId!);
    const scopedExternalGithubGrant = request.source === "mcp-tool"
      && (request.capability === "github.issue.write"
        || request.capability === "github.pull-request.write"
        || request.capability === "github.actions.run")
      && request.mcpServerId === "github-owner";

    if (
      !sandboxAllows(this.options.sandboxMode, request.capability)
      && !scopedFileChangeGrant
      && !scopedPeekabooClickGrant
      && !scopedCodexPermissionGrant
      && !scopedFloralSkillSupplyChainGrant
      && !scopedFloralExtensionSupplyChainGrant
      && !scopedFloralMaintenanceGrant
      && !scopedExternalBrowserGrant
      && !scopedExternalGithubGrant
    ) {
      return {
        status: "deny",
        approvalLevel: defaultLevel,
        reason: "sandbox-capability-denied",
      };
    }

    // Codex is the execution-policy authority for native command/file/
    // permission escalations. FLORAL authenticates who may answer the
    // already-issued Codex request; it does not maintain a second shell-risk
    // classifier.
    const codexNativeRemotePrompt = (
      request.source === "codex-command"
      && request.capability === "shell.execute"
    ) || (
      request.source === "codex-file-change"
      && request.capability === "files.write"
    ) || scopedCodexPermissionGrant;
    const level: ApprovalLevel = codexNativeRemotePrompt
      ? "chat-confirmation"
      : defaultLevel;

    if (level === "automatic") {
      return { status: "allow", approvalLevel: "automatic", reason: "automatic" };
    }
    return { status: "approval-required", approvalLevel: level, reason: "policy" };
  }

  #mcpToolAllowed(request: AuthorizationRequest): boolean {
    const serverId = request.mcpServerId;
    const toolName = request.mcpToolName;
    if (!serverId || !toolName) return false;
    const server = this.options.mcpRegistry.servers.find((candidate) =>
      candidate.id === serverId
      && candidate.enabled
      && candidate.integrationStatus === "active"
    );
    if (server) {
      return server.tools.some((tool) => tool.enabled && tool.name === toolName);
    }
    // External MCP servers are only materialized from FLORAL's curated,
    // machine-local registry. The request can only exist after Codex loaded
    // one of those exact server ids from the managed config overlay.
    return isCuratedExternalMcpServer(serverId)
      && externalMcpCapabilityForTool(serverId, toolName) !== undefined;
  }
}

function validGithubMcpApprovalScope(request: AuthorizationRequest): boolean {
  const scope = request.scope;
  if (!scope || scope.type !== "mcp-tool") return false;
  return scope.serverId === request.mcpServerId
    && scope.toolName === request.mcpToolName
    && /^sha256:[0-9a-f]{64}$/u.test(scope.argumentsDigest)
    && scope.target.length > 0
    && scope.target.length <= 240;
}

export function capabilityForMcpTool(
  serverId: string,
  toolName: string,
): Capability | undefined {
  if (serverId === "floral_search" && toolName === "searxng_web_search") {
    return "web.search";
  }
  if (serverId === "floral_vision") {
    return "screen.capture";
  }
  if (serverId === "floral_peekaboo" && toolName === "click") {
    return "application.control";
  }
  if (serverId === "floral_peekaboo" && (toolName === "image" || toolName === "see")) {
    return "screen.capture";
  }
  return externalMcpCapabilityForTool(serverId, toolName);
}

export function validateMcpCapabilityCoverage(registry: McpRuntimeRegistry): void {
  for (const server of registry.servers) {
    if (!server.enabled || server.integrationStatus !== "active") continue;
    for (const tool of server.tools) {
      if (!tool.enabled) continue;
      if (!capabilityForMcpTool(server.id, tool.name)) {
        throw new Error(
          `Active MCP tool has no FLORAL capability mapping: ${server.id}/${tool.name}`,
        );
      }
    }
  }
}

function sandboxAllows(
  mode: AuthorizationAuthorityOptions["sandboxMode"],
  capability: Capability,
): boolean {
  if (mode === "danger-full-access") return true;

  const readOnlyCapabilities = new Set<Capability>([
    "machine.status.read",
    "screen.capture",
    "files.read",
    "shell.execute",
    "web.search",
    "github.repository.read",
    "browser.inspect",
  ]);
  if (mode === "read-only") return readOnlyCapabilities.has(capability);

  if (readOnlyCapabilities.has(capability)) return true;
  return capability === "files.write" || capability === "application.open";
}

export function isExtensionMutationCapability(
  capability: Capability,
): capability is Extract<Capability, `extension.${string}`> {
  return capability === "extension.install"
    || capability === "extension.update"
    || capability === "extension.remove"
    || capability === "extension.enable"
    || capability === "extension.disable";
}

function validExtensionApprovalScope(
  capability: Extract<Capability, `extension.${string}`>,
  scope: AgentApprovalScope | undefined,
): boolean {
  if (!scope || scope.type !== "extension") return false;
  if (capability !== `extension.${scope.action}`) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u.test(scope.targetId)) return false;
  if (!scope.sourceId.trim() || !scope.sourceVersion.trim()) return false;
  if (scope.integrity !== undefined && !/^sha256:[0-9a-f]{64}$/u.test(scope.integrity)) {
    return false;
  }
  return scope.permissions.length > 0
    && scope.permissions.every((permission) => typeof permission === "string");
}

function validSkillPublishApprovalScope(
  scope: AgentApprovalScope | undefined,
): boolean {
  if (!scope || scope.type !== "skill-publish") return false;
  if (!/^[0-9a-f]{64}$/u.test(scope.projectId)) return false;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(scope.targetName)
    || scope.targetName.length > 64) return false;
  if (!/^sha256:[0-9a-f]{64}$/u.test(scope.digest)) return false;
  return scope.permissions.every((permission) => typeof permission === "string");
}
