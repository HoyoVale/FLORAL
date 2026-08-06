import { chmod, cp, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCodexDeepSeekConfig } from "../src/agent/codex-deepseek-config.js";
import {
  createCodexCutoverReport,
  writeCodexCutoverReport,
} from "../src/config/adoption/codex-controlled-cutover.js";
import {
  compareCodexShadowConfigs,
  writeCodexShadowReport,
} from "../src/config/adoption/codex-shadow-adoption.js";
import { renderCodexConfig } from "../src/config/adapters/codex-native-config.js";
import { renderNativeConfigBundle } from "../src/config/adapters/native-config-bundle.js";
import {
  buildConfigurationDiagnostics,
  explainConfigurationPath,
  renderConfigurationExplanation,
} from "../src/config/diagnostics/config-diagnostics.js";
import { resolveConfigurationAuthority } from "../src/config/federation/config-authority.js";
import { writeConfigurationDiagnostics } from "../src/config/federation/diagnostics-writer.js";
import { writeNativeConfigBundle } from "../src/config/federation/native-config-writer.js";

const repositoryRoot = resolve(".");

async function createRepositoryFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "floral-config-diagnostics-"));
  for (const relativePath of [
    ".env.example",
    "package.json",
    "config/floral.toml",
    "config/catalog/upstream-config-catalog.json",
    "config/catalog/runtime-compatibility.json",
    "src/config/env.ts",
    "infra/searxng/compose.yaml",
    "infra/searxng/settings.template.yml",
  ]) {
    const destination = join(root, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(repositoryRoot, relativePath), destination);
  }
  return root;
}

function productionEnvironment(root: string): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    QQ_MODE: "real",
    CODEX_MODE: "real",
    MACOS_MODE: "mock",
    AUTH_MODE: "local",
    CODEX_MANAGED_HOME: join(root, "data/codex-runtime"),
    QQBOT_APP_ID: "qq-app-id-sensitive",
    QQBOT_APP_SECRET: "qq-app-secret-sensitive",
    OWNER_PAIRING_CODE: "owner-pairing-code-sensitive",
    DEEPSEEK_API_KEY: "deepseek-api-key-sensitive",
  };
}

describe("configuration drift diagnostics", () => {
  it("compares requested, effective, rendered, installed, and observed layers", async () => {
    const root = await createRepositoryFixture();
    const authority = await resolveConfigurationAuthority({
      repositoryRoot: root,
      environment: {},
    });
    const bundle = renderNativeConfigBundle(authority);
    await writeNativeConfigBundle(root, bundle);

    const first = await buildConfigurationDiagnostics({
      repositoryRoot: root,
      authority,
      includeRuntimeProbes: false,
      now: new Date("2026-08-07T00:00:00.000Z"),
    });
    const second = await buildConfigurationDiagnostics({
      repositoryRoot: root,
      authority,
      includeRuntimeProbes: false,
      now: new Date("2026-08-07T01:00:00.000Z"),
    });

    expect(first.fingerprints).toEqual({
      requested: authority.requestedFingerprint,
      effective: authority.effectiveFingerprint,
      rendered: bundle.bundleFingerprint,
    });
    expect(first.nativeInstallation.manifestStatus).toBe("match");
    expect(first.nativeInstallation.artifacts.every((artifact) => artifact.status === "match")).toBe(true);
    expect(first.productionInstallation.codex.status).toBe("not-applicable");
    expect(first.runtime.codex.status).toBe("skipped");
    expect(first.runtime.searxng.status).toBe("skipped");
    expect(first.reportFingerprint).toBe(second.reportFingerprint);
    expect(first.cutoverGate.status).toBe("blocked");
  });

  it("normalizes the dynamic bridge URL when comparing installed Codex config", async () => {
    const root = await createRepositoryFixture();
    const authority = await resolveConfigurationAuthority({
      repositoryRoot: root,
      environment: productionEnvironment(root),
    });
    await writeNativeConfigBundle(root, renderNativeConfigBundle(authority));
    const configPath = join(root, "data/codex-runtime/config.toml");
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      renderCodexConfig(authority.effective, "http://127.0.0.1:49321/v1"),
      "utf8",
    );

    const report = await buildConfigurationDiagnostics({
      repositoryRoot: root,
      authority,
      includeRuntimeProbes: false,
    });
    expect(report.productionInstallation.codex.status).toBe("match");
    expect(report.findings.some((finding) => finding.code === "codex-managed-config-legacy-drift")).toBe(false);
  });

  it("detects a legacy managed Codex configuration without exposing secrets", async () => {
    const root = await createRepositoryFixture();
    const authority = await resolveConfigurationAuthority({
      repositoryRoot: root,
      environment: productionEnvironment(root),
    });
    await writeNativeConfigBundle(root, renderNativeConfigBundle(authority));
    const configPath = join(root, "data/codex-runtime/config.toml");
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, [
      'model = "deepseek-v4-flash"',
      'model_provider = "floral-deepseek"',
      'model_reasoning_effort = "high"',
      'base_url = "http://127.0.0.1:40123/v1"',
      "",
    ].join("\n"), "utf8");

    const report = await buildConfigurationDiagnostics({
      repositoryRoot: root,
      authority,
      includeRuntimeProbes: false,
    });
    expect(report.productionInstallation.codex.status).toBe("drift");
    expect(report.cutoverGate.blockerCodes).toContain("codex-managed-config-unified-drift");
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("deepseek-api-key-sensitive");
    expect(serialized).not.toContain("qq-app-secret-sensitive");
  });

  it("recognizes a current compatible Codex shadow report", async () => {
    const root = await createRepositoryFixture();
    const authority = await resolveConfigurationAuthority({
      repositoryRoot: root,
      environment: productionEnvironment(root),
    });
    await writeNativeConfigBundle(root, renderNativeConfigBundle(authority));
    const bridgeBaseUrl = "http://127.0.0.1:49321/v1";
    const legacy = buildCodexDeepSeekConfig({
      model: authority.effective.deepseek.model,
      bridgeBaseUrl,
      streamIdleTimeoutMs: authority.effective.deepseek.request_timeout_ms,
      searchMcp: {
        searxngUrl: authority.effective.search.service_url,
        packageSpec: authority.effective.mcp.search.package,
        startupTimeoutSec: authority.effective.mcp.search.startup_timeout_sec,
        toolTimeoutSec: authority.effective.mcp.search.tool_timeout_sec,
      },
    });
    await writeCodexShadowReport(root, compareCodexShadowConfigs({
      legacyConfig: legacy,
      unifiedConfig: renderCodexConfig(authority.effective, bridgeBaseUrl),
      effectiveFingerprint: authority.effectiveFingerprint,
    }));

    const report = await buildConfigurationDiagnostics({
      repositoryRoot: root,
      authority,
      includeRuntimeProbes: false,
    });
    expect(report.adoption.codexShadow.status).toBe("compatible");
    expect(report.cutoverGate.blockerCodes).not.toContain("codex-shadow-report-missing");
    expect(report.cutoverGate.blockerCodes).not.toContain("codex-shadow-drift");
  });

  it("keeps a compatible shadow report valid across unrelated service-only environment differences", async () => {
    const root = await createRepositoryFixture();
    const shellAuthority = await resolveConfigurationAuthority({
      repositoryRoot: root,
      environment: productionEnvironment(root),
    });
    const launchAgentAuthority = await resolveConfigurationAuthority({
      repositoryRoot: root,
      environment: {
        ...productionEnvironment(root),
        FLORAL_SERVICE_MODE: "launchagent",
        FLORAL_SERVICE_STATE_PATH: join(root, "data/service-state-launchagent.json"),
        FLORAL_INSTANCE_LOCK_PATH: join(root, "data/floral-launchagent.lock"),
      },
    });
    expect(launchAgentAuthority.effectiveFingerprint).not.toBe(shellAuthority.effectiveFingerprint);

    await writeNativeConfigBundle(root, renderNativeConfigBundle(shellAuthority));
    const bridgeBaseUrl = "http://127.0.0.1:49321/v1";
    const legacy = buildCodexDeepSeekConfig({
      model: launchAgentAuthority.effective.deepseek.model,
      bridgeBaseUrl,
      streamIdleTimeoutMs: launchAgentAuthority.effective.deepseek.request_timeout_ms,
      searchMcp: {
        searxngUrl: launchAgentAuthority.effective.search.service_url,
        packageSpec: launchAgentAuthority.effective.mcp.search.package,
        startupTimeoutSec: launchAgentAuthority.effective.mcp.search.startup_timeout_sec,
        toolTimeoutSec: launchAgentAuthority.effective.mcp.search.tool_timeout_sec,
      },
    });
    await writeCodexShadowReport(root, compareCodexShadowConfigs({
      legacyConfig: legacy,
      unifiedConfig: renderCodexConfig(launchAgentAuthority.effective, bridgeBaseUrl),
      effectiveFingerprint: launchAgentAuthority.effectiveFingerprint,
    }));

    const report = await buildConfigurationDiagnostics({
      repositoryRoot: root,
      authority: shellAuthority,
      includeRuntimeProbes: false,
    });
    expect(report.adoption.codexShadow.status).toBe("compatible");
    expect(report.cutoverGate.blockerCodes).not.toContain("codex-shadow-drift");
  });


  it("recognizes an active controlled Codex cutover for the current unified config", async () => {
    const root = await createRepositoryFixture();
    const authority = await resolveConfigurationAuthority({
      repositoryRoot: root,
      environment: productionEnvironment(root),
    });
    await writeNativeConfigBundle(root, renderNativeConfigBundle(authority));
    const bridgeBaseUrl = "http://127.0.0.1:49321/v1";
    const legacy = buildCodexDeepSeekConfig({
      model: authority.effective.deepseek.model,
      bridgeBaseUrl,
      streamIdleTimeoutMs: authority.effective.deepseek.request_timeout_ms,
      searchMcp: {
        searxngUrl: authority.effective.search.service_url,
        packageSpec: authority.effective.mcp.search.package,
        startupTimeoutSec: authority.effective.mcp.search.startup_timeout_sec,
        toolTimeoutSec: authority.effective.mcp.search.tool_timeout_sec,
      },
    });
    const unified = renderCodexConfig(authority.effective, bridgeBaseUrl);
    const shadow = compareCodexShadowConfigs({
      legacyConfig: legacy,
      unifiedConfig: unified,
      effectiveFingerprint: authority.effectiveFingerprint,
    });
    await writeCodexShadowReport(root, shadow);
    await writeCodexCutoverReport(root, createCodexCutoverReport({
      status: "active",
      activeConfig: "unified",
      effectiveFingerprint: authority.effectiveFingerprint,
      legacyConfig: legacy,
      unifiedConfig: unified,
      shadowReport: shadow,
      fallbackUsed: false,
      reasonCode: "unified-started",
    }));
    const configPath = join(root, "data/codex-runtime/config.toml");
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, unified, "utf8");

    const report = await buildConfigurationDiagnostics({
      repositoryRoot: root,
      authority,
      includeRuntimeProbes: false,
    });
    expect(report.productionInstallation.codex.status).toBe("match");
    expect(report.adoption.codexShadow.status).toBe("compatible");
    expect(report.adoption.codexCutover.status).toBe("active");
    expect(report.cutoverGate.blockerCodes).not.toContain("codex-cutover-report-missing");
    expect(report.cutoverGate.blockerCodes).not.toContain("codex-cutover-drift");
  });

  it("captures a bounded SearXNG effective configuration observation", async () => {
    const root = await createRepositoryFixture();
    const authority = await resolveConfigurationAuthority({
      repositoryRoot: root,
      environment: {},
    });
    await writeNativeConfigBundle(root, renderNativeConfigBundle(authority));
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
      engines: [{ name: "google" }, { name: "bing" }],
      plugins: ["Hash plugin"],
      categories: ["general", "images"],
      secret_key: "must-not-be-captured",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    const report = await buildConfigurationDiagnostics({
      repositoryRoot: root,
      authority,
      includeRuntimeProbes: true,
      fetchImpl,
    });
    expect(report.runtime.searxng).toMatchObject({
      status: "observed",
      engines: ["bing", "google"],
      plugins: ["Hash plugin"],
      categories: ["general", "images"],
    });
    expect(JSON.stringify(report.runtime.searxng)).not.toContain("must-not-be-captured");
  });

  it("explains provenance and writes a private redacted report", async () => {
    const root = await createRepositoryFixture();
    await chmod(root, 0o700);
    const authority = await resolveConfigurationAuthority({
      repositoryRoot: root,
      environment: { DEEPSEEK_REASONING_EFFORT: "max" },
    });
    const bundle = renderNativeConfigBundle(authority);
    const explanation = explainConfigurationPath(
      authority,
      bundle,
      "deepseek.reasoning_effort",
    );
    expect(explanation).toMatchObject({
      requested: "high",
      effective: "max",
      provenance: {
        source: "environment",
        sourceKey: "DEEPSEEK_REASONING_EFFORT",
      },
    });
    expect(renderConfigurationExplanation(explanation)).toContain(
      "config.explain.rendered_artifacts=codex/config.toml",
    );

    await writeNativeConfigBundle(root, bundle);
    const report = await buildConfigurationDiagnostics({
      repositoryRoot: root,
      authority,
      includeRuntimeProbes: false,
    });
    const paths = await writeConfigurationDiagnostics(root, report);
    const content = await readFile(paths.latest, "utf8");
    expect(JSON.parse(content)).toMatchObject({ reportFingerprint: report.reportFingerprint });
    expect(content).not.toContain("deepseek-api-key-sensitive");
    if (process.platform !== "win32") {
      expect((await stat(paths.directory)).mode & 0o777).toBe(0o700);
      expect((await stat(paths.latest)).mode & 0o777).toBe(0o600);
    }
  });
});
