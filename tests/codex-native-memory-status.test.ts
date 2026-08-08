import { describe, expect, it } from "vitest";
import {
  parseCodexMemoriesFeatureList,
  renderCodexNativeMemoryRuntimeLines,
} from "../src/agent/codex-native-memory-status.js";

describe("Codex native memory status", () => {
  it("parses the installed Codex feature-list surface without depending on column widths", () => {
    expect(parseCodexMemoriesFeatureList(
      "apps stable true\nmemories experimental true\nplugins stable true\n",
    )).toEqual({ status: "enabled", stage: "experimental" });
    expect(parseCodexMemoriesFeatureList(
      "memories under development false\n",
    )).toEqual({ status: "disabled", stage: "under development" });
    expect(parseCodexMemoriesFeatureList("apps stable true\n"))
      .toEqual({ status: "unavailable" });
  });

  it("renders configured-vs-effective state explicitly", () => {
    expect(renderCodexNativeMemoryRuntimeLines({
      configured: true,
      useMemories: true,
      generateMemories: true,
      disableOnExternalContext: false,
      control: "config",
      scope: "codex-home",
      activeConfig: "legacy",
      effective: false,
      storage: "absent",
      memoryIndex: "absent",
      rawMemories: "absent",
    })).toEqual(expect.arrayContaining([
      "codex_memory=configured-not-active",
      "codex_memory_scope=codex-home",
      "codex_memory_active_config=legacy",
    ]));
  });
});
