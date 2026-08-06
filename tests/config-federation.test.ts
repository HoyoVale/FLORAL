import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  listBoundEnvironmentKeys,
  renderConfigurationAuthority,
  resolveConfigurationAuthority,
  safeConfigurationJson,
  splitCommandArguments,
} from "../src/config/federation/config-authority.js";
import { writeEffectiveConfigBundle } from "../src/config/federation/private-config-writer.js";
import { parseFloralToml } from "../src/config/federation/simple-toml.js";
import { loadUpstreamConfigCatalog } from "../src/config/inventory/config-inventory.js";

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
    DEEPSEEK_REASONING_EFFORT: "max",
    CODEX_ARGS: 'app-server --flag "two words"',
  };
}

describe("configuration federation authority", () => {
  it("binds every inventoried environment key exactly once", async () => {
    const catalog = await loadUpstreamConfigCatalog(repositoryRoot);
    expect(listBoundEnvironmentKeys()).toEqual(
      Object.keys(catalog.environmentKeyPolicies).sort(),
    );
  });

  it("resolves requested and effective config with provenance and no secret values", async () => {
    const authority = await resolveConfigurationAuthority({
      repositoryRoot,
      environment: productionEnvironment(),
    });

    expect(authority.requested.codex.mode).toBe("mock");
    expect(authority.effective.codex.mode).toBe("real");
    expect(authority.effective.deepseek.reasoning_effort).toBe("max");
    expect(authority.effective.codex.args).toEqual(["app-server", "--flag", "two words"]);
    expect(authority.provenance["codex.mode"]).toMatchObject({
      source: "environment",
      sourceKey: "CODEX_MODE",
    });
    expect(authority.requestedFingerprint).not.toBe(authority.effectiveFingerprint);
    expect(authority.requestedFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(authority.effectiveFingerprint).toMatch(/^[a-f0-9]{64}$/u);

    const output = `${renderConfigurationAuthority(authority)}${JSON.stringify(safeConfigurationJson(authority))}`;
    for (const secret of [
      "qq-app-id-sensitive",
      "qq-app-secret-sensitive",
      "owner-pairing-code-sensitive",
      "deepseek-api-key-sensitive",
      "bridge-token-sensitive",
    ]) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain("config.secret.deepseek_api_key=present");
  });

  it("rejects locked-field overrides and unknown keys before runtime adoption", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "floral-config-locked-"));
    const original = await readFile(join(repositoryRoot, "config/floral.toml"), "utf8");
    const invalid = original
      .replace('mode = "read-only"', 'mode = "danger-full-access"')
      .replace("[floral]\n", "[floral]\nunknown_setting = true\n");
    const configPath = join(temporaryRoot, "floral.toml");
    await writeFile(configPath, invalid, "utf8");

    await expect(resolveConfigurationAuthority({
      repositoryRoot,
      configPath,
      environment: {},
    })).rejects.toThrow(/unknown_setting|locked field/u);
  });

  it("writes only private, redacted effective artifacts", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "floral-config-write-"));
    await chmod(temporaryRoot, 0o700);
    const authority = await resolveConfigurationAuthority({
      repositoryRoot,
      environment: productionEnvironment(),
    });
    const paths = await writeEffectiveConfigBundle(temporaryRoot, authority);
    const manifest = await readFile(paths.manifest, "utf8");
    expect(manifest).not.toContain("deepseek-api-key-sensitive");
    expect(manifest).not.toContain("qq-app-secret-sensitive");
    expect(JSON.parse(manifest)).toMatchObject({
      authorityVersion: 1,
      effectiveFingerprint: authority.effectiveFingerprint,
    });
    if (process.platform !== "win32") {
      expect((await stat(paths.directory)).mode & 0o777).toBe(0o700);
      expect((await stat(paths.manifest)).mode & 0o777).toBe(0o600);
    }
  });

  it("parses the constrained TOML contract and command arguments deterministically", () => {
    const parsed = parseFloralToml(`
      schema_version = 1
      [codex]
      args = ["app-server", "--flag"] # comment
      enabled = true
    `);
    expect(parsed.value).toEqual({
      schema_version: 1,
      codex: { args: ["app-server", "--flag"], enabled: true },
    });
    expect(parsed.explicitPaths).toEqual(new Set([
      "schema_version",
      "codex.args",
      "codex.enabled",
    ]));
    expect(splitCommandArguments('app-server --flag "two words"')).toEqual([
      "app-server",
      "--flag",
      "two words",
    ]);
  });
});
