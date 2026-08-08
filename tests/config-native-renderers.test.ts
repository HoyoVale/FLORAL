import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  renderNativeConfigBundle,
  safeNativeBundleJson,
} from "../src/config/adapters/native-config-bundle.js";
import {
  CODEX_BRIDGE_BASE_URL_PLACEHOLDER,
  renderCodexConfig,
  resolveCodexReasoningEffort,
} from "../src/config/adapters/codex-native-config.js";
import {
  CODEX_MODEL_CATALOG_PATH_PLACEHOLDER,
  renderCodexModelCatalog,
} from "../src/config/codex/codex-model-catalog.js";
import {
  renderSearxngCompose,
  renderSearxngSettings,
} from "../src/config/adapters/searxng-native-config.js";
import { resolveConfigurationAuthority } from "../src/config/federation/config-authority.js";
import { normalizeNativeConfigText } from "../src/config/adapters/native-config-types.js";
import { writeNativeConfigBundle } from "../src/config/federation/native-config-writer.js";

const repositoryRoot = resolve(".");

function productionEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    QQ_MODE: "real",
    CODEX_MODE: "real",
    MACOS_MODE: "mock",
    AUTH_MODE: "local",
    QQBOT_APP_ID: "qq-app-id-sensitive",
    QQBOT_APP_SECRET: "qq-app-secret-sensitive",
    OWNER_PAIRING_CODE: "owner-pairing-code-sensitive",
    DEEPSEEK_API_KEY: "deepseek-api-key-sensitive",
    FLORAL_BRIDGE_TOKEN: "bridge-token-sensitive",
  };
}

async function loadAuthority() {
  return await resolveConfigurationAuthority({
    repositoryRoot,
    environment: productionEnvironment(),
  });
}

describe("native configuration adapters", () => {
  it("renders a deterministic seven-artifact bundle", async () => {
    const authority = await loadAuthority();
    const first = renderNativeConfigBundle(authority);
    const second = renderNativeConfigBundle(authority);

    expect(first).toEqual(second);
    expect(first.artifacts.map((artifact) => artifact.relativePath)).toEqual([
      "codex/config.toml",
      "codex/model-catalog.json",
      "codex/requirements.toml",
      "mcp/manifest.json",
      "qq/sdk-options.json",
      "searxng/compose.yaml",
      "searxng/settings.yml",
    ]);
    expect(first.bundleFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.artifacts.every((artifact) => /^[a-f0-9]{64}$/u.test(artifact.sha256))).toBe(true);
  });

  it("renders Codex native fields, runtime substitution, and locked requirements", async () => {
    const authority = await loadAuthority();
    const config = structuredClone(authority.effective);
    config.codex.native.reasoning_effort = "xhigh";
    config.codex.native.reasoning_summary = "concise";

    const output = renderCodexConfig(config);
    expect(output).toContain('model_reasoning_effort = "xhigh"');
    expect(output).toContain('model_reasoning_summary = "concise"');
    expect(output).toContain(`base_url = "${CODEX_BRIDGE_BASE_URL_PLACEHOLDER}"`);
    expect(output).toContain(`model_catalog_json = "${CODEX_MODEL_CATALOG_PATH_PLACEHOLDER}"`);
    expect(output).toContain("[features]");
    expect(output).toContain("memories = true");
    expect(output).toContain("[memories]");
    expect(output).toContain("use_memories = true");
    expect(output).toContain("generate_memories = true");
    expect(output).toContain('extract_model = "deepseek-v4-flash"');
    expect(output).toContain('consolidation_model = "deepseek-v4-flash"');
    expect(output).toContain("disable_on_external_context = false");
    expect(output).toContain("[mcp_servers.floral_search]");
    expect(output).toContain('default_tools_approval_mode = "approve"');
    expect(output).toContain('[mcp_servers.floral_search.tools.searxng_web_search]');
    expect(output).not.toContain("deepseek-api-key-sensitive");

    config.codex.native.reasoning_effort = "inherit";
    config.deepseek.reasoning_effort = "max";
    expect(resolveCodexReasoningEffort(config)).toBe("xhigh");
    expect(renderCodexConfig(config)).toContain('model_reasoning_effort = "xhigh"');
  });


  it("renders pinned custom-model metadata with the freeform apply_patch surface", async () => {
    const catalog = JSON.parse(renderCodexModelCatalog("deepseek-v4-flash")) as {
      models: Array<Record<string, unknown>>;
    };
    expect(catalog.models).toHaveLength(1);
    expect(catalog.models[0]).toMatchObject({
      slug: "deepseek-v4-flash",
      apply_patch_tool_type: "freeform",
      shell_type: "shell_command",
      supports_parallel_tool_calls: false,
      supports_reasoning_summary_parameter: false,
      default_reasoning_summary: "none",
      context_window: 1_000_000,
      use_responses_lite: false,
    });
    expect(String(catalog.models[0]?.base_instructions)).toContain("*** Begin Patch");
  });

  it("keeps checked-in SearXNG native templates equal to renderer output", async () => {
    const authority = await loadAuthority();
    const [compose, settings] = await Promise.all([
      readFile(join(repositoryRoot, "infra/searxng/compose.yaml"), "utf8"),
      readFile(join(repositoryRoot, "infra/searxng/settings.template.yml"), "utf8"),
    ]);
    expect(normalizeNativeConfigText(renderSearxngCompose(authority.effective))).toBe(
      normalizeNativeConfigText(compose),
    );
    expect(normalizeNativeConfigText(renderSearxngSettings(authority.effective))).toBe(
      normalizeNativeConfigText(settings),
    );
    expect(settings).toContain('secret_key: "__FLORAL_SEARXNG_SECRET__"');
  });

  it("normalizes LF and CRLF checkouts before drift comparison", () => {
    expect(normalizeNativeConfigText("alpha\r\nbeta\r\n")).toBe("alpha\nbeta\n");
    expect(normalizeNativeConfigText("alpha\nbeta")).toBe("alpha\nbeta\n");
  });

  it("renders redacted QQ and MCP contracts without secret values", async () => {
    const authority = await loadAuthority();
    const bundle = renderNativeConfigBundle(authority);
    const output = `${JSON.stringify(safeNativeBundleJson(bundle))}\n${bundle.artifacts.map((artifact) => artifact.content).join("\n")}`;

    for (const secret of [
      "qq-app-id-sensitive",
      "qq-app-secret-sensitive",
      "owner-pairing-code-sensitive",
      "deepseek-api-key-sensitive",
      "bridge-token-sensitive",
    ]) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain('"name": "QQBOT_APP_SECRET"');
    expect(output).toContain('"inheritParentEnvironment": false');
    expect(output).toContain('"approvalMode": "approve"');
  });

  it("writes private native artifacts and a redacted manifest atomically", async () => {
    const authority = await loadAuthority();
    const bundle = renderNativeConfigBundle(authority);
    const temporaryRoot = await mkdtemp(join(tmpdir(), "floral-native-config-"));
    await chmod(temporaryRoot, 0o700);
    const paths = await writeNativeConfigBundle(temporaryRoot, bundle);
    const stalePath = join(paths.directory, "stale.txt");
    await writeFile(stalePath, "stale", "utf8");
    const rewrittenPaths = await writeNativeConfigBundle(temporaryRoot, bundle);

    expect(rewrittenPaths).toEqual(paths);
    await expect(readFile(stalePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(paths.artifacts).toHaveLength(7);
    const manifest = await readFile(paths.manifest, "utf8");
    expect(JSON.parse(manifest)).toMatchObject({
      bundleFingerprint: bundle.bundleFingerprint,
      effectiveFingerprint: authority.effectiveFingerprint,
    });
    expect(manifest).not.toContain("qq-app-secret-sensitive");
    if (process.platform !== "win32") {
      expect((await stat(paths.directory)).mode & 0o777).toBe(0o700);
      expect((await stat(paths.manifest)).mode & 0o777).toBe(0o600);
      for (const path of paths.artifacts) {
        expect((await stat(path)).mode & 0o777).toBe(0o600);
      }
    }
  });
});
