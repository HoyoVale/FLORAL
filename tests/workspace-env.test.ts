import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/config/env.js";

const deepSeek = { DEEPSEEK_API_KEY: "test-key" };

describe("workspace root environment authority", () => {
  it("keeps the workspace root optional and trims an explicit local value", () => {
    expect(loadEnv(deepSeek).FLORAL_WORKSPACE_ROOT).toBeUndefined();
    expect(loadEnv({
      ...deepSeek,
      FLORAL_WORKSPACE_ROOT: "  /tmp/AgentWorkspace  ",
    }).FLORAL_WORKSPACE_ROOT).toBe("/tmp/AgentWorkspace");
    expect(loadEnv({
      ...deepSeek,
      FLORAL_WORKSPACE_ROOT: "",
    }).FLORAL_WORKSPACE_ROOT).toBeUndefined();
  });
});
