import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfigurationAuthority } from "../src/config/federation/config-authority.js";
import {
  buildLegacyQqRuntimeOptionsContract,
  buildQqRuntimeOptionsContract,
  createUnifiedQqTransportOptions,
  safeQqRuntimeOptionsJson,
} from "../src/config/qq/qq-runtime-options.js";
import { loadEnv } from "../src/config/env.js";

const repositoryRoot = resolve(".");
const environment: NodeJS.ProcessEnv = {
  QQ_MODE: "real",
  QQBOT_APP_ID: "sensitive-app-id",
  QQBOT_APP_SECRET: "sensitive-app-secret",
  OWNER_PAIRING_CODE: "owner-pairing-code-sensitive",
  DEEPSEEK_API_KEY: "deepseek-sensitive",
};

describe("QQ runtime options authority", () => {
  it("builds a deterministic, secret-free runtime contract", async () => {
    const authority = await resolveConfigurationAuthority({ repositoryRoot, environment });
    const first = buildQqRuntimeOptionsContract(authority.effective);
    const second = buildQqRuntimeOptionsContract(authority.effective);
    expect(first).toEqual(second);
    expect(first.runtimeFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    const output = JSON.stringify(safeQqRuntimeOptionsJson(first, {
      appId: "QQBOT_APP_ID",
      appSecret: "QQBOT_APP_SECRET",
    }));
    expect(output).not.toContain("sensitive-app-id");
    expect(output).not.toContain("sensitive-app-secret");
    expect(output).toContain("QQBOT_APP_SECRET");
  });

  it("creates transport options from effective configuration and environment-only credentials", async () => {
    const authority = await resolveConfigurationAuthority({ repositoryRoot, environment });
    const options = createUnifiedQqTransportOptions({
      authority,
      repositoryRoot,
      environment,
    });
    expect(options.appId).toBe("sensitive-app-id");
    expect(options.appSecret).toBe("sensitive-app-secret");
    expect(options.dataDir).toBe(resolve(repositoryRoot, authority.effective.qq.session_dir));
    expect(options.nativeTypingEnabled).toBe(false);
    expect(options.sdk).toEqual({
      accountIdStrategy: "sha256-app-id",
      sessionPersistence: "file",
      tokenPrefetch: "sync",
      logger: "redacted",
    });
  });

  it("captures the established legacy options for one-shot rollback", () => {
    const env = loadEnv(environment);
    const legacy = buildLegacyQqRuntimeOptionsContract(env);
    expect(legacy.expectedVersion).toBe("1.0.4");
    expect(legacy.sdk.tokenPrefetch).toBe("sync");
    expect(legacy.session.layout).toBe("qq/account-fingerprint/session.json");
    expect(legacy.presentation.nativeTyping).toBe(false);
  });
});
