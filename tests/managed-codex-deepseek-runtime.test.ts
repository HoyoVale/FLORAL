import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ManagedCodexDeepSeekRuntime,
  createPersistentCodexWorkspace,
} from "../src/agent/managed-codex-deepseek-runtime.js";
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
    createWorkspace: async (config, codexHome) => {
      calls.push(config.includes("floral_search") ? "workspace.search" : "workspace.missing");
      calls.push(`workspace.home=${codexHome}`);
      return {
        codexHome: "/tmp/fake-codex",
        cleanup: async () => { calls.push("workspace.cleanup"); },
      };
    },
    createRuntime: ({ codexHome, bridgeToken }) => {
      calls.push(`${codexHome}:${bridgeToken}`);
      return runtime;
    },
    prepareCodexConfig: async ({ legacyConfig }) => ({
      mode: "legacy",
      productionConfig: legacyConfig,
    }),
    clearCodexShadowReport: async () => undefined,
  });
  return { managed, runtime, calls };
}

describe("ManagedCodexDeepSeekRuntime", () => {
  it("starts search, bridge, workspace, and Codex in order", async () => {
    const { managed, runtime, calls } = setup();
    await managed.start();
    expect(calls.slice(0, 5)).toEqual([
      "search",
      "bridge.start",
      "workspace.search",
      `workspace.home=${join(process.cwd(), "data", "codex-runtime")}`,
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

  it("keeps the legacy config in production while shadow preparation runs", async () => {
    let workspaceConfig = "";
    let shadowCalls = 0;
    const runtime = new FakeRuntime();
    const managed = new ManagedCodexDeepSeekRuntime(loadEnv({
      DEEPSEEK_API_KEY: "secret",
    }), {
      createToken: () => "token",
      checkSearch: async () => ({ endpoint: "http://127.0.0.1:8888", resultCount: 1 }),
      createBridge: () => ({
        start: async () => ({ baseUrl: "http://127.0.0.1:9999/v1" }),
        stop: async () => undefined,
      }),
      prepareCodexConfig: async ({ legacyConfig }) => {
        shadowCalls += 1;
        return {
          mode: "unified-shadow",
          productionConfig: legacyConfig,
        };
      },
      clearCodexShadowReport: async () => undefined,
      createWorkspace: async (config) => {
        workspaceConfig = config;
        return { codexHome: "/tmp/fake-codex", cleanup: async () => undefined };
      },
      createRuntime: () => runtime,
    });

    await managed.start();
    expect(shadowCalls).toBe(1);
    expect(workspaceConfig).toContain('model_provider = "floral-deepseek"');
    expect(workspaceConfig).not.toContain("approval_policy");
    await managed.stop();
  });

  it("falls back to the legacy generator when shadow preparation fails", async () => {
    let workspaceConfig = "";
    const runtime = new FakeRuntime();
    const managed = new ManagedCodexDeepSeekRuntime(loadEnv({
      DEEPSEEK_API_KEY: "secret",
    }), {
      createToken: () => "token",
      checkSearch: async () => ({ endpoint: "http://127.0.0.1:8888", resultCount: 1 }),
      createBridge: () => ({
        start: async () => ({ baseUrl: "http://127.0.0.1:9999/v1" }),
        stop: async () => undefined,
      }),
      prepareCodexConfig: async () => { throw new Error("shadow failed"); },
      clearCodexShadowReport: async () => undefined,
      createWorkspace: async (config) => {
        workspaceConfig = config;
        return { codexHome: "/tmp/fake-codex", cleanup: async () => undefined };
      },
      createRuntime: () => runtime,
    });

    await managed.start();
    expect(workspaceConfig).toContain('model_reasoning_effort = "high"');
    await managed.stop();
  });

  it("preserves Codex thread state while removing the ephemeral bridge config", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-managed-codex-test-"));
    const codexHome = join(root, "codex-home");
    try {
      const first = await createPersistentCodexWorkspace(codexHome, "first-config");
      const threadDir = join(codexHome, "sessions");
      const threadFile = join(threadDir, "thread-state.json");
      await mkdir(threadDir, { recursive: true });
      await writeFile(threadFile, "persisted", "utf8");
      expect(await readFile(join(codexHome, "config.toml"), "utf8")).toBe("first-config");

      await first.cleanup();
      await expect(stat(join(codexHome, "config.toml"))).rejects.toThrow();
      expect(await readFile(threadFile, "utf8")).toBe("persisted");

      const second = await createPersistentCodexWorkspace(codexHome, "second-config");
      expect(await readFile(join(codexHome, "config.toml"), "utf8")).toBe("second-config");
      expect(await readFile(threadFile, "utf8")).toBe("persisted");
      await second.cleanup();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
