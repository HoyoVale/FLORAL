import type { EffectiveConfig } from "../federation/config-authority.js";
import { createNativeConfigArtifact, type NativeConfigArtifact } from "./native-config-types.js";

export function renderMcpNativeArtifact(config: EffectiveConfig): NativeConfigArtifact {
  const search = config.mcp.search;
  const value = {
    schemaVersion: 1,
    servers: [
      {
        id: search.id,
        enabled: search.enabled,
        integrationStatus: "active",
        transport: {
          type: "stdio",
          command: search.command,
          args: [...search.command_args, search.package],
          inheritParentEnvironment: search.inherit_parent_environment,
          environment: {
            SEARXNG_URL: { kind: "literal", value: config.search.service_url },
            NO_PROXY: { kind: "literal", value: search.no_proxy },
          },
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
      },
      {
        id: config.mcp.vision.id,
        enabled: config.mcp.vision.enabled,
        integrationStatus: "planned",
        inheritParentEnvironment: config.mcp.vision.inherit_parent_environment,
        tools: [...config.mcp.vision.enabled_tools].sort(),
      },
      {
        id: config.mcp.macos.id,
        enabled: config.mcp.macos.enabled,
        integrationStatus: "planned",
        profile: config.mcp.macos.profile,
        inheritParentEnvironment: config.mcp.macos.inherit_parent_environment,
        tools: [...config.mcp.macos.enabled_tools].sort(),
      },
    ],
  };

  return createNativeConfigArtifact({
    component: "mcp",
    relativePath: "mcp/manifest.json",
    mediaType: "application/json",
    purpose: "Unified MCP transport, tool allowlist, timeout, and approval metadata.",
    active: true,
    runtimePlaceholders: [],
    content: `${JSON.stringify(value, null, 2)}\n`,
  });
}
