import { describe, expect, it } from "vitest";
import { renderCodexConfig } from "../src/config/adapters/codex-native-config.js";
import { renderMcpNativeArtifact } from "../src/config/adapters/mcp-native-config.js";
import { resolveConfigurationAuthority } from "../src/config/federation/config-authority.js";
import {
  buildMcpRuntimeRegistry,
  renderCodexMcpLines,
  validateMcpRuntimeRegistry,
} from "../src/config/mcp/mcp-runtime-registry.js";

async function fixture() {
  const authority = await resolveConfigurationAuthority({
    repositoryRoot: process.cwd(),
    environment: {
      DEEPSEEK_API_KEY: "deepseek-sensitive",
      QQBOT_APP_SECRET: "qq-sensitive",
    },
  });
  const registry = buildMcpRuntimeRegistry(authority.effective);
  return { authority, registry };
}

describe("MCP runtime registry", () => {
  it("builds a deterministic canonical registry with one active server", async () => {
    const { authority, registry } = await fixture();
    expect(buildMcpRuntimeRegistry(authority.effective)).toEqual(registry);
    expect(registry.registryFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(registry.servers.map((server) => [
      server.id,
      server.integrationStatus,
      server.enabled,
    ])).toEqual([
      ["floral_search", "active", true],
      ["floral_vision", "active", true],
      ["floral_peekaboo", "active", true],
    ]);
    expect(registry.servers[0]?.tools.map((tool) => tool.name)).toEqual([
      "searxng_web_search",
    ]);
    expect(registry.servers[1]?.tools.map((tool) => tool.name)).toEqual([
      "vision_analyze_region",
      "vision_analyze_screen",
    ]);
    expect(registry.servers[2]?.tools.map((tool) => tool.name)).toEqual([
      "image",
      "see",
    ]);
  });

  it("renders the Codex MCP projection from the same registry used by the manifest", async () => {
    const { authority, registry } = await fixture();
    const lines = renderCodexMcpLines(registry);
    const codex = renderCodexConfig(
      authority.effective,
      "http://127.0.0.1:9999/v1",
      registry,
    );
    expect(codex).toContain(lines.join("\n"));
    expect(codex).toContain('[mcp_servers.floral_search]');
    expect(codex).toContain('env = { SEARXNG_URL = "http://127.0.0.1:8888", NO_PROXY = "127.0.0.1,localhost,::1" }');
    expect(codex).toContain('[mcp_servers.floral_search.tools.searxng_web_search]');
    expect(codex).toContain('[mcp_servers.floral_peekaboo]');
    expect(codex).toContain('command = "peekaboo"');
    expect(codex).toContain('args = ["mcp"]');
    expect(codex).toContain('PEEKABOO_ALLOW_TOOLS = "image,see"');
    expect(codex).toContain('PEEKABOO_AI_PROVIDERS = ""');
    expect(codex).toContain('[mcp_servers.floral_peekaboo.tools.image]');
    expect(codex).toContain('[mcp_servers.floral_peekaboo.tools.see]');

    const manifest = renderMcpNativeArtifact(authority.effective).content;
    const parsed = JSON.parse(manifest) as {
      registryFingerprint: string;
      servers: Array<Record<string, unknown>>;
    };
    expect(parsed.registryFingerprint).toBe(registry.registryFingerprint);
    expect(parsed.servers[0]).toMatchObject({
      id: "floral_search",
      integrationStatus: "active",
    });
    expect(manifest).not.toContain("deepseek-sensitive");
    expect(manifest).not.toContain("qq-sensitive");
  });

  it("fails closed when a planned MCP adapter is enabled", async () => {
    const { authority } = await fixture();
    const config = structuredClone(authority.effective);
    config.mcp.vision.enabled = true;
    expect(() => buildMcpRuntimeRegistry(config)).toThrow(/Planned MCP server cannot be enabled/u);
  });

  it("detects registry fingerprint tampering", async () => {
    const { registry } = await fixture();
    const tampered = structuredClone(registry);
    tampered.registryFingerprint = "0".repeat(64);
    expect(() => validateMcpRuntimeRegistry(tampered)).toThrow(/fingerprint/u);
  });
});
