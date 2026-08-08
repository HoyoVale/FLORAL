import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/config/env.js";

describe("Mac-local remote mode ceiling", () => {
  it("defaults to auto and requires an explicit local full opt-in", () => {
    expect(loadEnv({}).FLORAL_REMOTE_MODE_CEILING).toBe("auto");
    expect(loadEnv({
      FLORAL_REMOTE_MODE_CEILING: "full",
    }).FLORAL_REMOTE_MODE_CEILING).toBe("full");
  });

  it("rejects unknown ceiling values", () => {
    expect(() => loadEnv({
      FLORAL_REMOTE_MODE_CEILING: "danger",
    })).toThrow(/FLORAL_REMOTE_MODE_CEILING/u);
  });
});
