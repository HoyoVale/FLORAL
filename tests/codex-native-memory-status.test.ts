import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyCodexNativeMemoryLifecycle,
  parseCodexMemoriesFeatureList,
  renderCodexNativeMemoryRuntimeLines,
  resolveCodexExecutableForProbe,
} from "../src/agent/codex-native-memory-status.js";

describe("Codex native memory status", () => {
  it("parses the installed Codex feature-list surface without depending on column widths", () => {
    expect(parseCodexMemoriesFeatureList(
      "apps stable true\nmemories experimental true\nplugins stable true\n",
    )).toEqual({ status: "enabled", stage: "experimental" });
    expect(parseCodexMemoriesFeatureList(
      "memories stable true\n",
    )).toEqual({ status: "enabled", stage: "stable" });
    expect(parseCodexMemoriesFeatureList(
      "memories under development false\n",
    )).toEqual({ status: "disabled", stage: "under development" });
    expect(parseCodexMemoriesFeatureList("apps stable true\n"))
      .toEqual({ status: "unavailable" });
  });

  it("classifies lifecycle evidence without treating generated artifacts as a second database", () => {
    expect(classifyCodexNativeMemoryLifecycle({
      effective: false,
      memoryIndex: "absent",
      rawMemories: "absent",
      rolloutSummaryCount: 0,
    })).toBe("inactive");
    expect(classifyCodexNativeMemoryLifecycle({
      effective: true,
      memoryIndex: "absent",
      rawMemories: "absent",
      rolloutSummaryCount: 0,
    })).toBe("armed");
    expect(classifyCodexNativeMemoryLifecycle({
      effective: true,
      memoryIndex: "absent",
      rawMemories: "present",
      rolloutSummaryCount: 3,
    })).toBe("generated");
    expect(classifyCodexNativeMemoryLifecycle({
      effective: true,
      memoryIndex: "present",
      rawMemories: "present",
      rolloutSummaryCount: 3,
    })).toBe("consolidated");
  });

  it("renders configured-vs-effective and lifecycle state explicitly", () => {
    expect(renderCodexNativeMemoryRuntimeLines({
      configured: true,
      useMemories: true,
      generateMemories: true,
      disableOnExternalContext: false,
      control: "config",
      scope: "codex-home",
      activeConfig: "legacy",
      runtimeConfig: "absent",
      effective: false,
      storage: "absent",
      memoryIndex: "absent",
      rawMemories: "absent",
      rolloutSummaryCount: 0,
      memoryIndexBytes: 0,
      rawMemoriesBytes: 0,
      lifecycle: "inactive",
    })).toEqual(expect.arrayContaining([
      "codex_memory=configured-not-active",
      "codex_memory_scope=codex-home",
      "codex_memory_active_config=legacy",
      "codex_memory_runtime_config=absent",
      "codex_memory_lifecycle=inactive",
      "codex_memory_rollout_summaries=0",
    ]));
  });

  it("falls back to the official standalone Codex path when the interactive PATH is incomplete", async () => {
    const home = await mkdtemp(join(tmpdir(), "floral-codex-home-"));
    try {
      const directory = join(home, ".local", "bin");
      await mkdir(directory, { recursive: true });
      const command = join(directory, "codex");
      await writeFile(command, "#!/bin/sh\nexit 0\n", "utf8");
      await chmod(command, 0o755);

      await expect(resolveCodexExecutableForProbe({
        command: "codex",
        pathValue: "/usr/bin:/bin",
        homeDir: home,
      })).resolves.toBe(command);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
