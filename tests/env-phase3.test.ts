import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/config/env.js";

describe("Phase 3 environment configuration", () => {
  it("uses persistent SQLite and trusted mock-owner defaults", () => {
    const env = loadEnv({});
    expect(env.DATABASE_PATH).toBe("./data/floral.sqlite");
    expect(env.MOCK_TRUST_OWNER).toBe(true);
  });

  it("requires a strong owner pairing code in real QQ mode", () => {
    expect(() => loadEnv({
      QQ_MODE: "real",
      QQBOT_APP_ID: "app-id",
      QQBOT_APP_SECRET: "app-secret",
    })).toThrow("OWNER_PAIRING_CODE");

    expect(() => loadEnv({
      QQ_MODE: "real",
      QQBOT_APP_ID: "app-id",
      QQBOT_APP_SECRET: "app-secret",
      OWNER_PAIRING_CODE: "too-short",
    })).toThrow(/12/);
  });

  it("accepts real QQ configuration with a sufficiently long pairing code", () => {
    const env = loadEnv({
      QQ_MODE: "real",
      QQBOT_APP_ID: "app-id",
      QQBOT_APP_SECRET: "app-secret",
      OWNER_PAIRING_CODE: "correct-horse-battery",
      MOCK_TRUST_OWNER: "false",
    });
    expect(env.QQ_MODE).toBe("real");
    expect(env.MOCK_TRUST_OWNER).toBe(false);
  });

  it("uses bounded QQ transport defaults", () => {
    const env = loadEnv({});
    expect(env.QQBOT_STARTUP_TIMEOUT_MS).toBe(30_000);
    expect(env.QQBOT_REPLY_TARGET_TTL_MS).toBe(240_000);
    expect(env.QQBOT_REPLY_TARGET_CACHE_ENTRIES).toBe(256);
    expect(env.QQBOT_TEXT_CHUNK_CHARACTERS).toBe(1_800);
    expect(env.QQBOT_MAX_REPLY_CHUNKS).toBe(4);
    expect(env.QQBOT_OUTBOUND_TIMEOUT_MS).toBe(30_000);
    expect(env.QQBOT_PROBE_TIMEOUT_MS).toBe(120_000);
  });

  it("rejects unsafe QQ reply and timeout bounds", () => {
    expect(() => loadEnv({
      QQBOT_REPLY_TARGET_TTL_MS: "9999",
    })).toThrow("QQBOT_REPLY_TARGET_TTL_MS");
    expect(() => loadEnv({
      QQBOT_MAX_REPLY_CHUNKS: "6",
    })).toThrow("QQBOT_MAX_REPLY_CHUNKS");
  });

});
