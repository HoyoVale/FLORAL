import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Codex DeepSeek bridge configuration", () => {
  it("disables hosted web search in the temporary probe config", async () => {
    const source = await readFile("scripts/codex-deepseek-probe.ts", "utf8");
    const webSearchIndex = source.indexOf('`web_search = "disabled"`');
    const providerSectionIndex = source.indexOf('`[model_providers.floral-deepseek]`');

    expect(webSearchIndex).toBeGreaterThanOrEqual(0);
    expect(providerSectionIndex).toBeGreaterThan(webSearchIndex);
  });

  it("disables hosted web search in the persistent example config", async () => {
    const source = await readFile(
      "config/codex/floral-deepseek-bridge.example.toml",
      "utf8",
    );
    const webSearchIndex = source.indexOf('web_search = "disabled"');
    const providerSectionIndex = source.indexOf("[model_providers.floral-deepseek]");

    expect(webSearchIndex).toBeGreaterThanOrEqual(0);
    expect(providerSectionIndex).toBeGreaterThan(webSearchIndex);
  });
});
