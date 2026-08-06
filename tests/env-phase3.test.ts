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
});
