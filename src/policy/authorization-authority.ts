import type { Capability, GatewayRole } from "../core/types.js";
import type { McpRuntimeRegistry } from "../config/mcp/mcp-runtime-registry.js";
import { approvalLevelFor, type ApprovalLevel } from "./approval.js";
import { roleAllows } from "./permissions.js";

export type AuthorizationSource =
  | "codex-command"
  | "codex-file-change"
  | "codex-permission-profile"
  | "mcp-tool"
  | "floral";

export interface AuthorizationRequest {
  role: GatewayRole;
  capability: Capability;
  source: AuthorizationSource;
  mcpServerId?: string | undefined;
  mcpToolName?: string | undefined;
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

    if (request.source === "mcp-tool" && !this.#mcpToolAllowed(request)) {
      return {
        status: "deny",
        approvalLevel: defaultLevel,
        reason: "mcp-tool-not-allowlisted",
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

    if (!sandboxAllows(this.options.sandboxMode, request.capability) && !scopedFileChangeGrant) {
      return {
        status: "deny",
        approvalLevel: defaultLevel,
        reason: "sandbox-capability-denied",
      };
    }

    // A Codex command approval is an escalation request. Until FLORAL has a
    // command classifier, remote chat must never be allowed to turn an opaque
    // shell request into an unsandboxed command. The Mac-local confirmation
    // phase will be the only route for these requests.
    const level: ApprovalLevel = request.source === "codex-command"
      ? "local-confirmation"
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
    if (!server) return false;
    return server.tools.some((tool) => tool.enabled && tool.name === toolName);
  }
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
  if (serverId === "floral_peekaboo" && (toolName === "image" || toolName === "see")) {
    return "screen.capture";
  }
  return undefined;
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
  ]);
  if (mode === "read-only") return readOnlyCapabilities.has(capability);

  if (readOnlyCapabilities.has(capability)) return true;
  return capability === "files.write" || capability === "application.open";
}
