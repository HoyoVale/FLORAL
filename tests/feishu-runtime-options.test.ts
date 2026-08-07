import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildFeishuRuntimeOptionsContract,
  resolveFeishuRuntimeCredentials,
  validateFeishuRuntimeOptionsContract,
} from "../src/config/feishu/feishu-runtime-options.js";
import { resolveConfigurationAuthority } from "../src/config/federation/config-authority.js";

const repositoryRoot = resolve(".");

describe("Feishu runtime options", () => {
  it("builds a deterministic secret-free production contract", async () => {
    const environment: NodeJS.ProcessEnv = {
      CHAT_TRANSPORT: "feishu",
      FEISHU_APP_ID: "cli-sensitive",
      FEISHU_APP_SECRET: "secret-sensitive",
      OWNER_PAIRING_CODE: "correct-horse-battery",
    };
    const authority = await resolveConfigurationAuthority({
      repositoryRoot,
      environment,
    });
    const contract = buildFeishuRuntimeOptionsContract(authority.effective);

    expect(contract.package).toBe("@larksuiteoapi/node-sdk");
    expect(contract.expectedVersion).toBe("1.36.0");
    expect(contract.ingress).toEqual({
      mode: "long-connection",
      isolation: "worker-thread",
    });
    expect(contract.delivery).toMatchObject({
      startupTimeoutMs: 30_000,
      outboundTimeoutMs: 30_000,
      textChunkBytes: 120_000,
      maxReplyChunks: 4,
    });
    expect(contract.runtimeFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(contract)).not.toContain("secret-sensitive");
  });

  it("resolves credentials only from the authority SecretRef environment names", async () => {
    const environment: NodeJS.ProcessEnv = {
      CHAT_TRANSPORT: "feishu",
      FEISHU_APP_ID: "cli_floral",
      FEISHU_APP_SECRET: "feishu-secret",
      OWNER_PAIRING_CODE: "correct-horse-battery",
    };
    const authority = await resolveConfigurationAuthority({
      repositoryRoot,
      environment,
    });

    expect(resolveFeishuRuntimeCredentials(authority, environment)).toEqual({
      appId: "cli_floral",
      appSecret: "feishu-secret",
    });
    expect(() => resolveFeishuRuntimeCredentials(authority, {
      ...environment,
      FEISHU_APP_SECRET: "",
    })).toThrow("FEISHU_APP_SECRET");
  });

  it("fails closed on runtime fingerprint drift", async () => {
    const authority = await resolveConfigurationAuthority({
      repositoryRoot,
      environment: {
        CHAT_TRANSPORT: "feishu",
        FEISHU_APP_ID: "cli_floral",
        FEISHU_APP_SECRET: "feishu-secret",
        OWNER_PAIRING_CODE: "correct-horse-battery",
      },
    });
    const contract = buildFeishuRuntimeOptionsContract(authority.effective);
    expect(() => validateFeishuRuntimeOptionsContract({
      ...contract,
      delivery: { ...contract.delivery, maxReplyChunks: 5 },
    })).toThrow("fingerprint");
  });
});
