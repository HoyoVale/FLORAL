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
  writeCodexShadowReport,
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
      "features.memories",
      "memories.disable_on_external_context",
      "memories.generate_memories",
      "memories.use_memories",
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


  it("rejects a widened FLORAL Peekaboo artifact root", async () => {
    const resolved = await authority();
    const unified = renderCodexConfig(
      resolved.effective,
      "http://127.0.0.1:9999/v1",
    );
    const tampered = unified.replace(
      /FLORAL_PEEKABOO_ALLOWED_ROOT = "[^"]+"/u,
      'FLORAL_PEEKABOO_ALLOWED_ROOT = "/tmp"',
    );
    expect(tampered).not.toBe(unified);
    const comparison = compareCodexShadowConfigs({
      legacyConfig: legacyConfig(),
      unifiedConfig: tampered,
      effectiveFingerprint: resolved.effectiveFingerprint,
    });
    expect(comparison.status).toBe("drift");
    expect(comparison.unexpectedUnifiedOnlyAssignments).toContain(
      "mcp_servers.floral_peekaboo.env",
    );
  });


  it("rejects auto-approval widening for FLORAL Peekaboo click", async () => {
    const resolved = await authority();
    const unified = renderCodexConfig(
      resolved.effective,
      "http://127.0.0.1:9999/v1",
    );
    const tampered = unified.replace(
      '[mcp_servers.floral_peekaboo.tools.click]\napproval_mode = "prompt"',
      '[mcp_servers.floral_peekaboo.tools.click]\napproval_mode = "approve"',
    );
    expect(tampered).not.toBe(unified);
    const comparison = compareCodexShadowConfigs({
      legacyConfig: legacyConfig(),
      unifiedConfig: tampered,
      effectiveFingerprint: resolved.effectiveFingerprint,
    });
    expect(comparison.status).toBe("drift");
    expect(comparison.unexpectedUnifiedOnlyAssignments).toContain(
      "mcp_servers.floral_peekaboo.tools.click.approval_mode",
    );
  });

  it("keeps runtime model-catalog installation paths outside the Phase 4 semantic fingerprint", () => {
    const withoutCatalog = 'model = "deepseek-v4-flash"\n';
    const withCatalog = [
      'model = "deepseek-v4-flash"',
      'model_catalog_json = "/tmp/floral/model-catalog.json"',
      '',
    ].join("\n");
    expect(fingerprintCodexConfigSemantics(withCatalog))
      .toBe(fingerprintCodexConfigSemantics(withoutCatalog));
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
      const shadowAuthority = structuredClone(resolved);
      shadowAuthority.effective.runtime.adoption.codex.mode = "unified-shadow";
      const legacy = legacyConfig();
      const result = await prepareCodexConfigAdoption({
        repositoryRoot: root,
        environment: {},
        legacyConfig: legacy,
        bridgeBaseUrl: "http://127.0.0.1:9999/v1",
        authority: shadowAuthority,
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

  it("activates unified output only when a current compatible shadow report exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-codex-unified-"));
    try {
      const resolved = await authority();
      const legacy = legacyConfig();
      const unified = renderCodexConfig(
        resolved.effective,
        "http://127.0.0.1:9999/v1",
      );
      const shadow = compareCodexShadowConfigs({
        legacyConfig: legacy,
        unifiedConfig: unified,
        effectiveFingerprint: resolved.effectiveFingerprint,
      });
      await writeCodexShadowReport(root, shadow);

      const result = await prepareCodexConfigAdoption({
        repositoryRoot: root,
        environment: {},
        legacyConfig: legacy,
        bridgeBaseUrl: "http://127.0.0.1:9999/v1",
        authority: resolved,
      });
      expect(result.mode).toBe("unified");
      expect(result.productionConfig).toContain("approval_policy");
      expect(result.fallbackConfig).toBe(legacy);
      expect(result.shadowReport?.status).toBe("compatible");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refreshes missing shadow evidence before unified cutover when current configs remain compatible", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-codex-unified-missing-"));
    try {
      const resolved = await authority();
      const legacy = legacyConfig();
      const result = await prepareCodexConfigAdoption({
        repositoryRoot: root,
        environment: {},
        legacyConfig: legacy,
        bridgeBaseUrl: "http://127.0.0.1:9999/v1",
        authority: resolved,
      });
      expect(result.mode).toBe("unified");
      expect(result.productionConfig).toContain("approval_policy");
      expect(result.fallbackConfig).toBe(legacy);
      expect(result.shadowReport?.status).toBe("compatible");
      const refreshed = await readCodexShadowReport(root);
      expect(refreshed?.reportFingerprint).toBe(result.shadowReport?.reportFingerprint);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks automatic unified shadow refresh when the current configs drift", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-codex-unified-drift-"));
    try {
      const resolved = await authority({ DEEPSEEK_REASONING_EFFORT: "max" });
      await expect(prepareCodexConfigAdoption({
        repositoryRoot: root,
        environment: {},
        legacyConfig: legacyConfig(),
        bridgeBaseUrl: "http://127.0.0.1:9999/v1",
        authority: resolved,
      })).rejects.toThrow(/shadow drift/u);
      await expect(readCodexShadowReport(root)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
