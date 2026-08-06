import type { EffectiveConfig } from "../federation/config-authority.js";
import {
  buildMcpRuntimeRegistry,
  safeMcpRuntimeRegistryJson,
} from "../mcp/mcp-runtime-registry.js";
import { createNativeConfigArtifact, type NativeConfigArtifact } from "./native-config-types.js";

export function renderMcpNativeArtifact(config: EffectiveConfig): NativeConfigArtifact {
  const registry = buildMcpRuntimeRegistry(config);
  return createNativeConfigArtifact({
    component: "mcp",
    relativePath: "mcp/manifest.json",
    mediaType: "application/json",
    purpose: "Canonical MCP runtime registry, transport, tool allowlist, timeout, and approval metadata.",
    active: true,
    runtimePlaceholders: [],
    content: `${JSON.stringify(safeMcpRuntimeRegistryJson(registry), null, 2)}\n`,
  });
}
