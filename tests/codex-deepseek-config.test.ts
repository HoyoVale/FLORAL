import { describe, expect, it } from "vitest";
import { buildCodexDeepSeekConfig } from "../src/agent/codex-deepseek-config.js";

describe("Codex DeepSeek configuration", () => {
  it("disables the incompatible hosted web search tool", () => {
    const config = buildCodexDeepSeekConfig({
      model: "deepseek-v4-flash",
      bridgeBaseUrl: "http://127.0.0.1:8790/v1",
      streamIdleTimeoutMs: 120_000,
    });

    expect(config).toContain('web_search = "disabled"');
    expect(config.indexOf('web_search = "disabled"'))
      .toBeLessThan(config.indexOf("[model_providers.floral-deepseek]"));
  });

  it("pins and allow-lists only the SearXNG search MCP tool", () => {
    const config = buildCodexDeepSeekConfig({
      model: "deepseek-v4-flash",
      bridgeBaseUrl: "http://127.0.0.1:8790/v1",
      streamIdleTimeoutMs: 120_000,
      searchMcp: {
        searxngUrl: "http://127.0.0.1:8888",
        packageSpec: "mcp-searxng@1.0.3",
        startupTimeoutSec: 60,
        toolTimeoutSec: 45,
      },
    });

    expect(config).toContain('args = ["-y", "mcp-searxng@1.0.3"]');
    expect(config).toContain('enabled_tools = ["searxng_web_search"]');
    expect(config).toContain('default_tools_approval_mode = "approve"');
    expect(config).not.toContain("web_url_read");
  });
});
