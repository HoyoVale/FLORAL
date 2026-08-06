import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/config/env.js";

describe("service environment", () => {
  it("uses foreground-safe local defaults", () => {
    const env = loadEnv({});
    expect(env.FLORAL_SERVICE_MODE).toBe("foreground");
    expect(env.FLORAL_INSTANCE_LOCK_PATH).toBe("./data/floral.lock");
    expect(env.FLORAL_SERVICE_STATE_PATH).toBe("./data/service-state.json");
  });

  it("accepts LaunchAgent-owned absolute runtime paths", () => {
    const env = loadEnv({
      FLORAL_SERVICE_MODE: "launchagent",
      FLORAL_INSTANCE_LOCK_PATH: "/repo/data/floral.lock",
      FLORAL_SERVICE_STATE_PATH: "/repo/data/service-state.json",
    });
    expect(env.FLORAL_SERVICE_MODE).toBe("launchagent");
    expect(env.FLORAL_INSTANCE_LOCK_PATH).toBe("/repo/data/floral.lock");
    expect(env.FLORAL_SERVICE_STATE_PATH).toBe("/repo/data/service-state.json");
  });
});
