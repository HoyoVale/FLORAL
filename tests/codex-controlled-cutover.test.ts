import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCodexDeepSeekConfig } from "../src/agent/codex-deepseek-config.js";
import {
  assessCodexCutoverReport,
  createCodexCutoverReport,
  readCodexCutoverReport,
  writeCodexCutoverReport,
} from "../src/config/adoption/codex-controlled-cutover.js";
import {
  compareCodexShadowConfigs,
} from "../src/config/adoption/codex-shadow-adoption.js";
import { renderCodexConfig } from "../src/config/adapters/codex-native-config.js";
import { resolveConfigurationAuthority } from "../src/config/federation/config-authority.js";

async function fixture() {
  const authority = await resolveConfigurationAuthority({
    repositoryRoot: process.cwd(),
    environment: {},
  });
  const legacyConfig = buildCodexDeepSeekConfig({
    model: authority.effective.deepseek.model,
    bridgeBaseUrl: "http://127.0.0.1:9999/v1",
    streamIdleTimeoutMs: authority.effective.deepseek.request_timeout_ms,
    searchMcp: {
      searxngUrl: authority.effective.search.service_url,
      packageSpec: authority.effective.mcp.search.package,
      startupTimeoutSec: authority.effective.mcp.search.startup_timeout_sec,
      toolTimeoutSec: authority.effective.mcp.search.tool_timeout_sec,
    },
  });
  const unifiedConfig = renderCodexConfig(
    authority.effective,
    "http://127.0.0.1:9999/v1",
  );
  const shadowReport = compareCodexShadowConfigs({
    legacyConfig,
    unifiedConfig,
    effectiveFingerprint: authority.effectiveFingerprint,
    now: new Date("2026-08-07T00:00:00.000Z"),
  });
  return { authority, legacyConfig, unifiedConfig, shadowReport };
}

describe("Codex controlled cutover report", () => {
  it("records a successful unified activation without storing configuration values", async () => {
    const { authority, legacyConfig, unifiedConfig, shadowReport } = await fixture();
    const report = createCodexCutoverReport({
      status: "active",
      activeConfig: "unified",
      effectiveFingerprint: authority.effectiveFingerprint,
      legacyConfig,
      unifiedConfig,
      shadowReport,
      fallbackUsed: false,
      reasonCode: "unified-started",
      now: new Date("2026-08-07T01:00:00.000Z"),
    });

    expect(assessCodexCutoverReport(report, unifiedConfig)).toBe("active");
    expect(report.activeCodexConfigFingerprint).toBe(report.targetCodexConfigFingerprint);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("http://127.0.0.1:9999/v1");
    expect(serialized).not.toContain("FLORAL_BRIDGE_TOKEN");
  });

  it("marks a recovered legacy rollback as a blocking state", async () => {
    const { authority, legacyConfig, unifiedConfig, shadowReport } = await fixture();
    const report = createCodexCutoverReport({
      status: "rolled-back",
      activeConfig: "legacy",
      effectiveFingerprint: authority.effectiveFingerprint,
      legacyConfig,
      unifiedConfig,
      shadowReport,
      fallbackUsed: true,
      reasonCode: "unified-start-failed-legacy-recovered",
      startupError: new TypeError("sensitive message must not be stored"),
    });

    expect(assessCodexCutoverReport(report, unifiedConfig)).toBe("rolled-back");
    expect(report.startupErrorType).toBe("TypeError");
    expect(JSON.stringify(report)).not.toContain("sensitive message");
  });

  it("detects a stale target configuration fingerprint", async () => {
    const { authority, legacyConfig, unifiedConfig, shadowReport } = await fixture();
    const report = createCodexCutoverReport({
      status: "active",
      activeConfig: "unified",
      effectiveFingerprint: authority.effectiveFingerprint,
      legacyConfig,
      unifiedConfig,
      shadowReport,
      fallbackUsed: false,
      reasonCode: "unified-started",
    });

    expect(assessCodexCutoverReport(
      report,
      unifiedConfig.replace('model_reasoning_effort = "high"', 'model_reasoning_effort = "xhigh"'),
    )).toBe("drift");
  });

  it("writes and validates a private atomic report", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-codex-cutover-"));
    try {
      const { authority, legacyConfig, unifiedConfig, shadowReport } = await fixture();
      const report = createCodexCutoverReport({
        status: "active",
        activeConfig: "unified",
        effectiveFingerprint: authority.effectiveFingerprint,
        legacyConfig,
        unifiedConfig,
        shadowReport,
        fallbackUsed: false,
        reasonCode: "unified-started",
      });
      const path = await writeCodexCutoverReport(root, report);
      expect((await readCodexCutoverReport(root))?.reportFingerprint).toBe(report.reportFingerprint);
      if (process.platform !== "win32") {
        expect((await stat(join(root, "data/config/adoption"))).mode & 0o777).toBe(0o700);
        expect((await stat(path)).mode & 0o777).toBe(0o600);
      }

      const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      parsed.effectiveFingerprint = "0".repeat(64);
      await writeFile(path, `${JSON.stringify(parsed)}\n`, "utf8");
      await expect(readCodexCutoverReport(root)).rejects.toThrow(/fingerprint/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
