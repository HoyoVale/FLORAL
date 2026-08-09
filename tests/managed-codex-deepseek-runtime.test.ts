import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ManagedCodexDeepSeekRuntime,
  createPersistentCodexWorkspace,
} from "../src/agent/managed-codex-deepseek-runtime.js";
import { compareCodexShadowConfigs } from "../src/config/adoption/codex-shadow-adoption.js";
import {
  CODEX_MODEL_CATALOG_PATH_PLACEHOLDER,
  CODEX_MODEL_CATALOG_RUNTIME_FILENAME,
  renderCodexModelCatalog,
} from "../src/config/codex/codex-model-catalog.js";
import { resolveConfigurationAuthority } from "../src/config/federation/config-authority.js";
import { buildMcpRuntimeRegistry } from "../src/config/mcp/mcp-runtime-registry.js";
import { loadEnv } from "../src/config/env.js";
import type { AgentRuntime, AgentSkillSummary } from "../src/core/contracts.js";
import type { AgentRunRequest, AgentRunResult } from "../src/core/types.js";
import { projectRuntimeNamespace } from "../src/workspace/project-workspace.js";

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
  async listSkills(): Promise<AgentSkillSummary[]> {
    return [{
      name: "system-status",
      description: "Collect status",
      path: "/tmp/skills/system-status/SKILL.md",
      scope: "user",
      enabled: true,
    }];
  }
  async stop(): Promise<void> { this.stops += 1; }
}

async function createEmptyMcpRegistry() {
  const authority = await resolveConfigurationAuthority({
    repositoryRoot: process.cwd(),
    environment: {},
  });
  const config = structuredClone(authority.effective);
  config.mcp.search.enabled = false;
  config.mcp.vision.enabled = false;
  config.mcp.macos.enabled = false;
  return buildMcpRuntimeRegistry(config);
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
    clearCodexCutoverReport: async () => undefined,
    clearMcpRegistryAdoptionReport: async () => undefined,
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


  it("passes the FLORAL turn-scoped approval profile to Codex runtime creation", async () => {
    let observed: { approvalPolicy: string; sandboxMode: string; approvalsReviewer: string } | undefined;
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
      prepareCodexConfig: async ({ legacyConfig }) => ({
        mode: "legacy",
        productionConfig: legacyConfig,
      }),
      clearCodexShadowReport: async () => undefined,
      clearCodexCutoverReport: async () => undefined,
      clearMcpRegistryAdoptionReport: async () => undefined,
      createWorkspace: async () => ({
        codexHome: "/tmp/fake-codex",
        cleanup: async () => undefined,
      }),
      createRuntime: (options) => {
        observed = {
          approvalPolicy: options.approvalPolicy,
          sandboxMode: options.sandboxMode,
          approvalsReviewer: options.approvalsReviewer,
        };
        return runtime;
      },
    }, {
      codexTurnApprovalPolicy: "untrusted",
      codexSandboxMode: "workspace-write",
      codexApprovalsReviewer: "user",
    });

    await managed.start();
    expect(observed).toEqual({
      approvalPolicy: "untrusted",
      sandboxMode: "workspace-write",
      approvalsReviewer: "user",
    });
    await managed.stop();
  });

  it("delegates skill discovery to the owned Codex runtime", async () => {
    const { managed } = setup();
    await managed.start();
    await expect(managed.listSkills({ cwd: process.cwd() })).resolves.toEqual([
      expect.objectContaining({ name: "system-status", enabled: true }),
    ]);
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

  it("routes different workspace projects into independent Codex homes while sharing the bridge", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-project-runtime-"));
    const workspaceRoot = join(root, "workspace");
    const projectA = join(workspaceRoot, "alpha");
    const projectB = join(workspaceRoot, "beta");
    const managedHome = join(root, "codex-runtime");
    const dataDir = join(root, "data");
    await mkdir(projectA, { recursive: true });
    await mkdir(projectB, { recursive: true });

    const bridgeCalls: string[] = [];
    const runtimeByHome = new Map<string, FakeRuntime>();
    const runtimeOptionsByHome = new Map<string, {
      permissionProfile?: string | undefined;
      permissionProfileCwd?: string | undefined;
    }>();
    const workspaceConfigs = new Map<string, string>();
    const managed = new ManagedCodexDeepSeekRuntime(loadEnv({
      DEEPSEEK_API_KEY: "secret",
      FLORAL_WORKSPACE_ROOT: workspaceRoot,
      CODEX_MANAGED_HOME: managedHome,
      DATA_DIR: dataDir,
    }), {
      createToken: () => "token",
      checkSearch: async () => ({ endpoint: "http://127.0.0.1:8888", resultCount: 1 }),
      createBridge: () => ({
        start: async () => {
          bridgeCalls.push("start");
          return { baseUrl: "http://127.0.0.1:9999/v1" };
        },
        stop: async () => { bridgeCalls.push("stop"); },
      }),
      prepareCodexConfig: async ({ legacyConfig }) => ({
        mode: "legacy",
        productionConfig: `${legacyConfig}\n# FLORAL_VISION_INBOUND_ROOT test fixture\nFLORAL_VISION_INBOUND_ROOT = ${JSON.stringify(join(dataDir, "inbound", "feishu"))}\n`,
      }),
      clearCodexShadowReport: async () => undefined,
      clearCodexCutoverReport: async () => undefined,
      clearMcpRegistryAdoptionReport: async () => undefined,
      createWorkspace: async (config, codexHome) => {
        workspaceConfigs.set(codexHome, config);
        return {
          codexHome,
          cleanup: async () => undefined,
        };
      },
      createRuntime: ({ codexHome, permissionProfile, permissionProfileCwd }) => {
        const runtime = new FakeRuntime();
        runtimeByHome.set(codexHome, runtime);
        runtimeOptionsByHome.set(codexHome, {
          permissionProfile,
          permissionProfileCwd,
        });
        return runtime;
      },
    });

    try {
      await managed.start();
      await managed.run({ text: "alpha one", cwd: projectA });
      await managed.run({ text: "alpha two", cwd: projectA });
      await managed.run({ text: "beta", cwd: projectB });

      const canonicalProjectA = await realpath(projectA);
      const canonicalProjectB = await realpath(projectB);
      const alphaKey = projectRuntimeNamespace(canonicalProjectA);
      const betaKey = projectRuntimeNamespace(canonicalProjectB);
      const alphaHome = join(managedHome, "projects", alphaKey);
      const betaHome = join(managedHome, "projects", betaKey);

      await expect(managed.resolveRuntimeHome({ cwd: projectA })).resolves.toBe(alphaHome);
      await expect(managed.resolveRuntimeHome({ cwd: projectB })).resolves.toBe(betaHome);
      expect(runtimeByHome.has(managedHome)).toBe(true);
      expect(runtimeByHome.has(alphaHome)).toBe(true);
      expect(runtimeByHome.has(betaHome)).toBe(true);
      expect(runtimeByHome.size).toBe(3);
      expect(runtimeByHome.get(alphaHome)?.starts).toBe(1);
      expect(runtimeByHome.get(betaHome)?.starts).toBe(1);
      expect(bridgeCalls).toEqual(["start"]);
      expect(runtimeOptionsByHome.get(managedHome)?.permissionProfile).toBeUndefined();
      expect(runtimeOptionsByHome.get(alphaHome)).toEqual({
        permissionProfile: "floral-project",
        permissionProfileCwd: canonicalProjectA,
      });
      expect(runtimeOptionsByHome.get(betaHome)).toEqual({
        permissionProfile: "floral-project",
        permissionProfileCwd: canonicalProjectB,
      });

      expect(workspaceConfigs.get(alphaHome)).toContain(
        '[permissions.floral-project.filesystem.":workspace_roots"]',
      );
      expect(workspaceConfigs.get(alphaHome)).toContain('"." = "write"');
      expect(workspaceConfigs.get(alphaHome)).toContain(
        `${JSON.stringify(resolve(process.cwd(), "skills"))} = "read"`,
      );
      expect(workspaceConfigs.get(alphaHome)).toContain(
        `${JSON.stringify(join(dataDir, "projects", alphaKey, "inbound", "feishu"))} = "read"`,
      );

      expect(workspaceConfigs.get(alphaHome)).toContain(
        `FLORAL_VISION_INBOUND_ROOT = ${JSON.stringify(join(dataDir, "projects", alphaKey, "inbound", "feishu"))}`,
      );
      expect(workspaceConfigs.get(betaHome)).toContain(
        `FLORAL_VISION_INBOUND_ROOT = ${JSON.stringify(join(dataDir, "projects", betaKey, "inbound", "feishu"))}`,
      );
    } finally {
      await managed.stop();
      await rm(root, { recursive: true, force: true });
    }
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
      clearCodexCutoverReport: async () => undefined,
      clearMcpRegistryAdoptionReport: async () => undefined,
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
      clearCodexCutoverReport: async () => undefined,
      clearMcpRegistryAdoptionReport: async () => undefined,
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


  it("installs a private model catalog and materializes its absolute path into Codex config", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-codex-model-catalog-test-"));
    const codexHome = join(root, "codex-home");
    const catalog = renderCodexModelCatalog("deepseek-v4-flash");
    const config = `model_catalog_json = ${JSON.stringify(CODEX_MODEL_CATALOG_PATH_PLACEHOLDER)}\n`;
    try {
      const workspace = await createPersistentCodexWorkspace(codexHome, config, { modelCatalog: catalog });
      const catalogPath = join(codexHome, CODEX_MODEL_CATALOG_RUNTIME_FILENAME);
      expect(await readFile(catalogPath, "utf8")).toBe(catalog);
      expect(await readFile(join(codexHome, "config.toml"), "utf8"))
        .toBe(`model_catalog_json = ${JSON.stringify(catalogPath)}\n`);
      if (process.platform !== "win32") {
        expect((await stat(catalogPath)).mode & 0o777).toBe(0o600);
      }
      await workspace.cleanup();
      await expect(stat(catalogPath)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves Codex thread state while removing the ephemeral bridge config", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-managed-codex-test-"));
    const codexHome = join(root, "codex-home");
    try {
      const first = await createPersistentCodexWorkspace(codexHome, "first-config", {
        fallbackConfig: "legacy-fallback",
      });
      const threadDir = join(codexHome, "sessions");
      const threadFile = join(threadDir, "thread-state.json");
      await mkdir(threadDir, { recursive: true });
      await writeFile(threadFile, "persisted", "utf8");
      expect(await readFile(join(codexHome, "config.toml"), "utf8")).toBe("first-config");
      expect(await readFile(join(codexHome, "config.legacy-fallback.toml"), "utf8"))
        .toBe("legacy-fallback");
      await first.replaceConfig?.("replacement-config");
      expect(await readFile(join(codexHome, "config.toml"), "utf8")).toBe("replacement-config");

      await first.cleanup();
      await expect(stat(join(codexHome, "config.toml"))).rejects.toThrow();
      await expect(stat(join(codexHome, "config.legacy-fallback.toml"))).rejects.toThrow();
      expect(await readFile(threadFile, "utf8")).toBe("persisted");

      const second = await createPersistentCodexWorkspace(codexHome, "second-config");
      expect(await readFile(join(codexHome, "config.toml"), "utf8")).toBe("second-config");
      expect(await readFile(threadFile, "utf8")).toBe("persisted");
      await second.cleanup();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("activates the unified config and records a successful controlled cutover", async () => {
    const legacyConfig = 'model = "same"\n';
    const unifiedConfig = 'model = "same"\napproval_policy = "never"\nsandbox_mode = "read-only"\nmodel_reasoning_summary = "auto"\n';
    const shadowReport = compareCodexShadowConfigs({
      legacyConfig,
      unifiedConfig,
      effectiveFingerprint: "effective-fingerprint",
    });
    const mcpRegistry = await createEmptyMcpRegistry();
    const runtime = new FakeRuntime();
    let workspaceConfig = "";
    let reportStatus = "";
    const managed = new ManagedCodexDeepSeekRuntime(loadEnv({
      DEEPSEEK_API_KEY: "secret",
    }), {
      createToken: () => "token",
      checkSearch: async () => ({ endpoint: "http://127.0.0.1:8888", resultCount: 1 }),
      createBridge: () => ({
        start: async () => ({ baseUrl: "http://127.0.0.1:9999/v1" }),
        stop: async () => undefined,
      }),
      prepareCodexConfig: async () => ({
        mode: "unified",
        productionConfig: unifiedConfig,
        fallbackConfig: legacyConfig,
        effectiveFingerprint: "effective-fingerprint",
        codexConfigFingerprint: shadowReport.codexConfigFingerprint,
        shadowReport,
        mcpRegistry,
      }),
      createWorkspace: async (config) => {
        workspaceConfig = config;
        return {
          codexHome: "/tmp/fake-codex",
          replaceConfig: async (replacement) => { workspaceConfig = replacement; },
          cleanup: async () => undefined,
        };
      },
      createRuntime: () => runtime,
      recordCodexCutover: async (report) => {
        reportStatus = report.status;
        return "/tmp/codex-cutover.json";
      },
      recordMcpRegistryAdoption: async () => "/tmp/mcp-registry.json",
      clearCodexShadowReport: async () => undefined,
      clearCodexCutoverReport: async () => undefined,
      clearMcpRegistryAdoptionReport: async () => undefined,
    });

    await managed.start();
    expect(workspaceConfig).toBe(unifiedConfig);
    expect(reportStatus).toBe("active");
    expect(runtime.starts).toBe(1);
    await managed.stop();
  });

  it("rolls back when the MCP registry adoption report cannot be persisted", async () => {
    const legacyConfig = 'model = "same"\n';
    const unifiedConfig = 'model = "same"\napproval_policy = "never"\nsandbox_mode = "read-only"\nmodel_reasoning_summary = "auto"\n';
    const shadowReport = compareCodexShadowConfigs({
      legacyConfig,
      unifiedConfig,
      effectiveFingerprint: "effective-fingerprint",
    });
    const mcpRegistry = await createEmptyMcpRegistry();
    const first = new FakeRuntime();
    const second = new FakeRuntime();
    const runtimes = [first, second];
    let runtimeIndex = 0;
    let workspaceConfig = "";
    let reportStatus = "";
    const managed = new ManagedCodexDeepSeekRuntime(loadEnv({
      DEEPSEEK_API_KEY: "secret",
    }), {
      createToken: () => "token",
      checkSearch: async () => ({ endpoint: "http://127.0.0.1:8888", resultCount: 1 }),
      createBridge: () => ({
        start: async () => ({ baseUrl: "http://127.0.0.1:9999/v1" }),
        stop: async () => undefined,
      }),
      prepareCodexConfig: async () => ({
        mode: "unified",
        productionConfig: unifiedConfig,
        fallbackConfig: legacyConfig,
        effectiveFingerprint: "effective-fingerprint",
        codexConfigFingerprint: shadowReport.codexConfigFingerprint,
        shadowReport,
        mcpRegistry,
      }),
      createWorkspace: async (config) => {
        workspaceConfig = config;
        return {
          codexHome: "/tmp/fake-codex",
          replaceConfig: async (replacement) => { workspaceConfig = replacement; },
          cleanup: async () => undefined,
        };
      },
      createRuntime: () => runtimes[runtimeIndex++]!,
      recordMcpRegistryAdoption: async () => {
        throw new Error("report write failed");
      },
      recordCodexCutover: async (report) => {
        reportStatus = report.status;
        return "/tmp/codex-cutover.json";
      },
      clearCodexShadowReport: async () => undefined,
      clearCodexCutoverReport: async () => undefined,
      clearMcpRegistryAdoptionReport: async () => undefined,
    });

    await managed.start();
    expect(workspaceConfig).toBe(legacyConfig);
    expect(first.stops).toBe(1);
    expect(second.starts).toBe(1);
    expect(reportStatus).toBe("rolled-back");
    await managed.stop();
  });

  it("retries once with the saved legacy config when unified startup fails", async () => {
    const legacyConfig = 'model = "same"\n';
    const unifiedConfig = 'model = "same"\napproval_policy = "never"\nsandbox_mode = "read-only"\nmodel_reasoning_summary = "auto"\n';
    const shadowReport = compareCodexShadowConfigs({
      legacyConfig,
      unifiedConfig,
      effectiveFingerprint: "effective-fingerprint",
    });
    const mcpRegistry = await createEmptyMcpRegistry();
    const first = new FakeRuntime();
    first.start = async () => { throw new Error("unified failed"); };
    const second = new FakeRuntime();
    const runtimes = [first, second];
    let runtimeIndex = 0;
    let workspaceConfig = "";
    let reportStatus = "";
    const managed = new ManagedCodexDeepSeekRuntime(loadEnv({
      DEEPSEEK_API_KEY: "secret",
    }), {
      createToken: () => "token",
      checkSearch: async () => ({ endpoint: "http://127.0.0.1:8888", resultCount: 1 }),
      createBridge: () => ({
        start: async () => ({ baseUrl: "http://127.0.0.1:9999/v1" }),
        stop: async () => undefined,
      }),
      prepareCodexConfig: async () => ({
        mode: "unified",
        productionConfig: unifiedConfig,
        fallbackConfig: legacyConfig,
        effectiveFingerprint: "effective-fingerprint",
        codexConfigFingerprint: shadowReport.codexConfigFingerprint,
        shadowReport,
        mcpRegistry,
      }),
      createWorkspace: async (config) => {
        workspaceConfig = config;
        return {
          codexHome: "/tmp/fake-codex",
          replaceConfig: async (replacement) => { workspaceConfig = replacement; },
          cleanup: async () => undefined,
        };
      },
      createRuntime: () => runtimes[runtimeIndex++]!,
      recordCodexCutover: async (report) => {
        reportStatus = report.status;
        return "/tmp/codex-cutover.json";
      },
      recordMcpRegistryAdoption: async () => "/tmp/mcp-registry.json",
      clearCodexShadowReport: async () => undefined,
      clearCodexCutoverReport: async () => undefined,
      clearMcpRegistryAdoptionReport: async () => undefined,
    });

    await managed.start();
    expect(workspaceConfig).toBe(legacyConfig);
    expect(first.stops).toBe(1);
    expect(second.starts).toBe(1);
    expect(reportStatus).toBe("rolled-back");
    await managed.stop();
  });

});
