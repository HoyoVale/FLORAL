import { describe, expect, it } from "vitest";
import { resolveConfigurationAuthority } from "../src/config/federation/config-authority.js";
import {
  buildMcpRuntimeRegistry,
  renderCodexMcpLines,
} from "../src/config/mcp/mcp-runtime-registry.js";

describe("Phase 6A.2B vision MCP registry activation", () => {
  it("projects only a SecretRef name and the exact read-only vision surface", async () => {
    const authority = await resolveConfigurationAuthority({
      repositoryRoot: process.cwd(),
      environment: { MIMO_API_KEY: "mimo-super-sensitive-test-value" },
    });
    expect(authority.effective.secrets.mimo_api_key).toEqual({
      kind: "environment",
      name: "MIMO_API_KEY",
      present: true,
    });

    const registry = buildMcpRuntimeRegistry(authority.effective);
    const vision = registry.servers.find((server) => server.id === "floral_vision");
    expect(vision).toBeDefined();
    expect(vision).toMatchObject({
      enabled: true,
      integrationStatus: "active",
      required: false,
      startupTimeoutSec: 60,
      toolTimeoutSec: 120,
      defaultToolsApprovalMode: "approve",
    });
    expect(vision?.tools.map((tool) => [tool.name, tool.approvalMode])).toEqual([
      ["vision_analyze_region", "approve"],
      ["vision_analyze_screen", "approve"],
    ]);

    const rendered = renderCodexMcpLines(registry).join("\n");
    expect(rendered).toContain("[mcp_servers.floral_vision]");
    expect(rendered).toContain('env_vars = ["MIMO_API_KEY"]');
    expect(rendered).toContain('MIMO_BASE_URL = "https://api.xiaomimimo.com/v1"');
    expect(rendered).toContain('MIMO_VISION_MODEL = "mimo-v2.5"');
    expect(rendered).toContain('enabled_tools = ["vision_analyze_region", "vision_analyze_screen"]');
    expect(rendered).not.toContain("mimo-super-sensitive-test-value");
    expect(JSON.stringify(registry)).not.toContain("mimo-super-sensitive-test-value");
  });

  it("fails closed if the vision tool surface is widened", async () => {
    const authority = await resolveConfigurationAuthority({
      repositoryRoot: process.cwd(),
      environment: {},
    });
    const config = structuredClone(authority.effective);
    config.mcp.vision.enabled_tools.push("vision_read_arbitrary_file");
    expect(() => buildMcpRuntimeRegistry(config)).toThrow(/vision MCP tool surface drift/u);
  });
});
