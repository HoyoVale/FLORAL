import { describe, expect, it } from "vitest";
import { ManagedCodexDeepSeekRuntime } from "../src/agent/managed-codex-deepseek-runtime.js";
import { loadEnv } from "../src/config/env.js";
import type { AgentRuntime } from "../src/core/contracts.js";
import type { AgentRunRequest, AgentRunResult } from "../src/core/types.js";

class FakeRuntime implements AgentRuntime {
  readonly name = "fake";
  starts = 0;
  stops = 0;
  interrupts = 0;
  async start(): Promise<void> { this.starts += 1; }
  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    return { threadId: request.threadId ?? "thread-1", finalText: "ok" };
  }
  async interrupt(): Promise<void> { this.interrupts += 1; }
  async stop(): Promise<void> { this.stops += 1; }
}

function setup(options: { runtimeStartError?: Error } = {}) {
  const calls: string[] = [];
  const runtime = new FakeRuntime();
  if (options.runtimeStartError) {
    runtime.start = async () => { throw options.runtimeStartError; };
  }
  const managed = new ManagedCodexDeepSeekRuntime(loadEnv({
    DEEPSEEK_API_KEY: "secret",
  }), {
    createToken: () => "token",
    checkSearch: async () => {
      calls.push("search");
      return { endpoint: "http://127.0.0.1:8888", resultCount: 1 };
    },
    createBridge: () => ({
      start: async () => {
        calls.push("bridge.start");
        return { baseUrl: "http://127.0.0.1:9999/v1" };
      },
      stop: async () => { calls.push("bridge.stop"); },
    }),
    createWorkspace: async (config) => {
      calls.push(config.includes("floral_search") ? "workspace.search" : "workspace.missing");
      return {
        codexHome: "/tmp/fake-codex",
        cleanup: async () => { calls.push("workspace.cleanup"); },
      };
    },
    createRuntime: ({ codexHome, bridgeToken }) => {
      calls.push(`${codexHome}:${bridgeToken}`);
      return runtime;
    },
  });
  return { managed, runtime, calls };
}

describe("ManagedCodexDeepSeekRuntime", () => {
  it("starts search, bridge, workspace, and Codex in order", async () => {
    const { managed, runtime, calls } = setup();
    await managed.start();
    expect(calls.slice(0, 4)).toEqual([
      "search",
      "bridge.start",
      "workspace.search",
      "/tmp/fake-codex:token",
    ]);
    expect(runtime.starts).toBe(1);
    await managed.stop();
  });

  it("delegates run and interrupt", async () => {
    const { managed, runtime } = setup();
    await managed.start();
    await expect(managed.run({ text: "hello", cwd: "." })).resolves.toEqual({
      threadId: "thread-1",
      finalText: "ok",
    });
    await managed.interrupt("thread-1");
    expect(runtime.interrupts).toBe(1);
    await managed.stop();
  });

  it("stops owned resources exactly once", async () => {
    const { managed, runtime, calls } = setup();
    await managed.start();
    await managed.stop();
    await managed.stop();
    expect(runtime.stops).toBe(1);
    expect(calls.filter((entry) => entry === "bridge.stop")).toHaveLength(1);
    expect(calls.filter((entry) => entry === "workspace.cleanup")).toHaveLength(1);
  });

  it("cleans bridge and workspace when Codex startup fails", async () => {
    const { managed, calls } = setup({ runtimeStartError: new Error("failed") });
    await expect(managed.start()).rejects.toThrow("failed");
    expect(calls).toContain("bridge.stop");
    expect(calls).toContain("workspace.cleanup");
  });
});
