import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCodexDeepSeekConfig } from "../src/agent/codex-deepseek-config.js";
import {
  compareCodexShadowConfigs,
  fingerprintCodexConfigSemantics,
  prepareCodexConfigAdoption,
  readCodexShadowReport,
} from "../src/config/adoption/codex-shadow-adoption.js";
import { renderCodexConfig } from "../src/config/adapters/codex-native-config.js";
import { resolveConfigurationAuthority } from "../src/config/federation/config-authority.js";

const repositoryRoot = process.cwd();

async function authority(environment: NodeJS.ProcessEnv = {}) {
  return await resolveConfigurationAuthority({
    repositoryRoot,
    environment,
  });
}

function legacyConfig(options: { reasoningTimeoutMs?: number } = {}): string {
  return buildCodexDeepSeekConfig({
    model: "deepseek-v4-flash",
    bridgeBaseUrl: "http://127.0.0.1:9999/v1",
    streamIdleTimeoutMs: options.reasoningTimeoutMs ?? 120_000,
    searchMcp: {
      searxngUrl: "http://127.0.0.1:8888",
      packageSpec: "mcp-searxng@1.0.3",
      startupTimeoutSec: 60,
      toolTimeoutSec: 45,
    },
  });
}

describe("Codex unified shadow adoption", () => {
  it("treats locked unified additions as compatible with the legacy generator", async () => {
    const resolved = await authority();
    const comparison = compareCodexShadowConfigs({
      legacyConfig: legacyConfig(),
      unifiedConfig: renderCodexConfig(
        resolved.effective,
        "http://127.0.0.1:9999/v1",
      ),
      effectiveFingerprint: resolved.effectiveFingerprint,
      now: new Date("2026-08-07T00:00:00.000Z"),
    });

    expect(comparison.status).toBe("compatible");
    expect(comparison.expectedUnifiedOnlyAssignments).toEqual([
      "approval_policy",
      "model_reasoning_summary",
      "sandbox_mode",
    ]);
    expect(comparison.differingAssignments).toEqual([]);
    expect(fingerprintCodexConfigSemantics(renderCodexConfig(
      resolved.effective,
      "http://127.0.0.1:9999/v1",
    ))).toBe(fingerprintCodexConfigSemantics(renderCodexConfig(
      resolved.effective,
      "http://127.0.0.1:49152/v1",
    )));
  });

  it("detects a real reasoning-effort difference without exposing values", async () => {
    const resolved = await authority({ DEEPSEEK_REASONING_EFFORT: "max" });
    const comparison = compareCodexShadowConfigs({
      legacyConfig: legacyConfig(),
      unifiedConfig: renderCodexConfig(
        resolved.effective,
        "http://127.0.0.1:9999/v1",
      ),
      effectiveFingerprint: resolved.effectiveFingerprint,
    });

    expect(comparison.status).toBe("drift");
    expect(comparison.differingAssignments).toEqual(["model_reasoning_effort"]);
    expect(JSON.stringify(comparison)).not.toContain("xhigh");
  });

  it("writes a private atomic report while returning the legacy production config", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-codex-shadow-"));
    try {
      await writeFile(join(root, "config.toml"), "", "utf8");
      const resolved = await authority();
      const legacy = legacyConfig();
      const result = await prepareCodexConfigAdoption({
        repositoryRoot: root,
        environment: {},
        legacyConfig: legacy,
        bridgeBaseUrl: "http://127.0.0.1:9999/v1",
        authority: resolved,
      });

      expect(result.mode).toBe("unified-shadow");
      expect(result.productionConfig).toBe(legacy);
      expect(result.shadowReport?.status).toBe("compatible");
      const report = await readCodexShadowReport(root);
      expect(report?.reportFingerprint).toBe(result.shadowReport?.reportFingerprint);
      if (process.platform !== "win32") {
        expect((await stat(join(root, "data/config/adoption"))).mode & 0o777).toBe(0o700);
        expect((await stat(join(root, "data/config/adoption/codex-shadow.json"))).mode & 0o777).toBe(0o600);
      }
      expect(await readFile(join(root, "data/config/adoption/codex-shadow.json"), "utf8"))
        .not.toContain("FLORAL_BRIDGE_TOKEN");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses legacy mode as an explicit rollback without creating a shadow report", async () => {
    const resolved = await authority();
    const rollback = structuredClone(resolved);
    rollback.effective.runtime.adoption.codex.mode = "legacy";
    const root = await mkdtemp(join(tmpdir(), "floral-codex-legacy-"));
    try {
      const legacy = legacyConfig();
      const result = await prepareCodexConfigAdoption({
        repositoryRoot: root,
        environment: {},
        legacyConfig: legacy,
        bridgeBaseUrl: "http://127.0.0.1:9999/v1",
        authority: rollback,
      });
      expect(result).toEqual({ mode: "legacy", productionConfig: legacy });
      await expect(readCodexShadowReport(root)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
