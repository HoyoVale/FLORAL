import { describe, expect, it } from "vitest";
import { loadEnv, normalizeEnvCompatibility } from "../src/config/env.js";

describe("Mac-local remote mode ceiling", () => {
  it("defaults to auto and requires an explicit local full opt-in", () => {
    expect(loadEnv({}).FLORAL_REMOTE_MODE_CEILING).toBe("auto");
    expect(loadEnv({
      FLORAL_REMOTE_MODE_CEILING: "full",
    }).FLORAL_REMOTE_MODE_CEILING).toBe("full");
  });


  it("recovers the common Phase 8D.1 maintenance-ceiling placement typo", () => {
    const normalized = normalizeEnvCompatibility({
      FLORAL_REMOTE_MODE_CEILING: "owner-auto",
    });
    expect(normalized.source.FLORAL_REMOTE_MODE_CEILING).toBe("auto");
    expect(normalized.source.FLORAL_MAINTENANCE_MODE_CEILING).toBe("owner-auto");
    expect(normalized.notices).toContainEqual(expect.objectContaining({
      code: "maintenance-ceiling-misplaced",
    }));

    const env = loadEnv({
      FLORAL_REMOTE_MODE_CEILING: "self-heal",
    });
    expect(env.FLORAL_REMOTE_MODE_CEILING).toBe("auto");
    expect(env.FLORAL_MAINTENANCE_MODE_CEILING).toBe("self-heal");
  });

  it("keeps an explicitly configured maintenance ceiling while recovering a misplaced remote value", () => {
    const env = loadEnv({
      FLORAL_REMOTE_MODE_CEILING: "owner-auto",
      FLORAL_MAINTENANCE_MODE_CEILING: "self-heal",
    });
    expect(env.FLORAL_REMOTE_MODE_CEILING).toBe("auto");
    expect(env.FLORAL_MAINTENANCE_MODE_CEILING).toBe("self-heal");
  });

  it("rejects unknown ceiling values", () => {
    expect(() => loadEnv({
      FLORAL_REMOTE_MODE_CEILING: "danger",
    })).toThrow(/FLORAL_REMOTE_MODE_CEILING/u);
  });
});
