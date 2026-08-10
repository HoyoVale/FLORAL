import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AgentAppReadResult,
  AgentAppSummary,
  AgentExtensionDiscoveryRuntime,
  AgentMcpServerSummary,
  AgentNativeFeatureSummary,
  AgentRuntime,
  AgentSkillRuntime,
  AgentSkillSummary,
} from "../src/core/contracts.js";
import { loadEnv } from "../src/config/env.js";
import { resolveConfigurationAuthority } from "../src/config/federation/config-authority.js";
import {
  EXTERNAL_MCP_REGISTRY_VERSION,
  resolveExternalMcpRegistryPaths,
  writeExternalMcpRegistry,
} from "../src/extensions/external-mcp-registry.js";
import { CodexRuntimeSystemObserver } from "../src/system-awareness/observers/codex-runtime-system-observer.js";
import { ConfigurationSystemObserver } from "../src/system-awareness/observers/configuration-system-observer.js";
import { ExternalExtensionSystemObserver } from "../src/system-awareness/observers/external-extension-system-observer.js";
import { ExecutionContextSystemObserver } from "../src/system-awareness/observers/execution-context-system-observer.js";
import {
  ServiceStateSystemObserver,
} from "../src/system-awareness/observers/service-state-system-observer.js";
import { createServiceStateWriter } from "../src/runtime/service-state.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Phase 8A read-only observers", () => {
  it("records Gateway intent separately from the exact Codex turn permission selector", async () => {
    const observer = new ExecutionContextSystemObserver({
      now: () => new Date("2026-08-10T00:00:00.000Z"),
    });
    const evidence = await observer.observe({
      execution: {
        gateway: {
          controlMode: "full",
          sandboxMode: "danger-full-access",
          approvalPolicy: "untrusted",
          approvalsReviewer: "user",
          approvalRoute: "full-auto-owner-trusted",
        },
        turn: {
          selector: "permission-profile",
          sandboxMode: "not-applicable",
          permissionProfile: "floral-project",
          approvalPolicy: "untrusted",
          approvalsReviewer: "user",
        },
      },
    });
    expect(evidence.find((item) => item.fact === "gateway.requested_sandbox")).toMatchObject({
      confidence: "authoritative",
      value: "danger-full-access",
      source: { id: "gateway-execution-policy", kind: "runtime-context" },
    });
    expect(evidence.find((item) => item.fact === "turn.selector")).toMatchObject({
      confidence: "authoritative",
      value: "permission-profile",
      source: { id: "codex-turn-execution", kind: "runtime-context" },
    });
    expect(evidence.find((item) => item.fact === "turn.permission_profile")).toMatchObject({
      value: "floral-project",
    });
    expect(evidence.find((item) => item.fact === "turn.sandbox_mode")).toMatchObject({
      value: "not-applicable",
    });
  });

  it("keeps app/list fallback as directory evidence and leaves installed/callable unknown", async () => {
    const runtime = new FakeDiscoveryRuntime({
      installedApps: [{
        id: "calendar",
        runtimeName: "Calendar",
        enabled: true,
        accessible: true,
        source: "directory-fallback",
      }],
      availableApps: [{
        id: "calendar",
        runtimeName: "Calendar",
        enabled: true,
        accessible: true,
        source: "directory",
      }],
    });
    const observer = new CodexRuntimeSystemObserver({
      runtime,
      now: () => new Date("2026-08-10T00:00:00.000Z"),
    });
    const evidence = await observer.observe({ cwd: "/tmp/project" });
    expect(evidence.find((item) => item.componentId === "codex.apps" && item.fact === "installed"))
      .toMatchObject({ confidence: "unknown", value: null, reason: "app-installed-unavailable" });
    expect(evidence.find((item) => item.componentId === "codex.apps" && item.fact === "callability"))
      .toMatchObject({ confidence: "unknown", value: null });
    expect(evidence.find((item) => item.componentId === "codex.apps" && item.fact === "directory_fallback"))
      .toMatchObject({ confidence: "observed" });
    expect(evidence.find((item) => item.componentId === "codex.apps" && item.fact === "directory"))
      .toMatchObject({ confidence: "authoritative" });
  });

  it("keeps MCP registry intent separate from Codex runtime readiness", async () => {
    const runtime = new FakeDiscoveryRuntime({
      mcpServers: [{
        name: "floral_peekaboo",
        status: "ready",
        tools: [{ name: "image", readOnly: true }, { name: "click", readOnly: false }],
      }],
    });
    const observer = new CodexRuntimeSystemObserver({
      runtime,
      now: () => new Date("2026-08-10T00:00:00.000Z"),
    });
    const evidence = await observer.observe({ cwd: "/tmp/project" });
    const mcp = evidence.find((item) => item.componentId === "codex.mcp" && item.fact === "servers");
    const peekaboo = evidence.find((item) => item.componentId === "mcp.floral_peekaboo" && item.fact === "runtime");
    expect(mcp).toMatchObject({ confidence: "authoritative", source: { id: "codex-mcp-status" } });
    expect(peekaboo).toMatchObject({ confidence: "authoritative" });
    expect(JSON.stringify(peekaboo)).toContain("click");
  });

  it("reports configuration secret presence without exposing secret values", async () => {
    const environment = {
      NODE_ENV: "test",
      DEEPSEEK_API_KEY: "never-emit-this-provider-secret",
      GITHUB_PAT_TOKEN: "never-emit-this-github-secret",
    } satisfies NodeJS.ProcessEnv;
    const authority = await resolveConfigurationAuthority({
      repositoryRoot: process.cwd(),
      environment,
    });
    const env = loadEnv(environment);
    const observer = new ConfigurationSystemObserver({
      authority,
      env,
      now: () => new Date("2026-08-10T00:00:00.000Z"),
    });
    const evidence = await observer.observe({});
    const serialized = JSON.stringify(evidence);
    expect(serialized).toContain("DEEPSEEK_API_KEY");
    expect(serialized).toContain("GITHUB_PAT_TOKEN");
    expect(serialized).not.toContain("never-emit-this-provider-secret");
    expect(serialized).not.toContain("never-emit-this-github-secret");
  });

  it("observes external MCP registry metadata and auth presence without credential values", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-system-awareness-ext-"));
    directories.push(root);
    const paths = resolveExternalMcpRegistryPaths(root, "./data");
    await writeExternalMcpRegistry(paths, {
      version: EXTERNAL_MCP_REGISTRY_VERSION,
      packages: [{
        id: "github-readonly",
        enabled: true,
        installedAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T00:00:00.000Z",
      }],
    });
    const observer = new ExternalExtensionSystemObserver({
      repositoryRoot: root,
      dataDir: "./data",
      environment: { GITHUB_PAT_TOKEN: "never-return-this-token" },
      now: () => new Date("2026-08-10T00:00:00.000Z"),
    });
    const evidence = await observer.observe({});
    const serialized = JSON.stringify(evidence);
    expect(serialized).toContain("github-readonly");
    expect(serialized).toContain("GITHUB_PAT_TOKEN");
    expect(serialized).toContain('"present":true');
    expect(serialized).not.toContain("never-return-this-token");
  });

  it("keeps service state and process liveness on separate evidence lanes", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-system-awareness-service-"));
    directories.push(root);
    const path = join(root, "service-state.json");
    await createServiceStateWriter(path, {
      pid: 777,
      instanceId: "instance-test",
      now: () => new Date("2026-08-10T00:00:00.000Z"),
    }).write("ready");
    const observer = new ServiceStateSystemObserver({
      statePath: path,
      checkProcess: () => "dead",
      now: () => new Date("2026-08-10T00:00:01.000Z"),
    });
    const evidence = await observer.observe({});
    expect(evidence.find((item) => item.fact === "recorded.phase")).toMatchObject({
      confidence: "authoritative",
      value: "ready",
      source: { id: "service-state", kind: "filesystem" },
    });
    expect(evidence.find((item) => item.fact === "process.alive")).toMatchObject({
      confidence: "observed",
      value: false,
      source: { id: "process-liveness", kind: "process" },
    });
  });
});

class FakeDiscoveryRuntime implements AgentRuntime, AgentSkillRuntime, AgentExtensionDiscoveryRuntime {
  readonly name = "fake-codex";
  readonly #installedApps: AgentAppSummary[];
  readonly #availableApps: AgentAppSummary[];
  readonly #mcpServers: AgentMcpServerSummary[];
  readonly #skills: AgentSkillSummary[];
  readonly #features: AgentNativeFeatureSummary[];

  constructor(options: {
    installedApps?: AgentAppSummary[];
    availableApps?: AgentAppSummary[];
    mcpServers?: AgentMcpServerSummary[];
    skills?: AgentSkillSummary[];
    features?: AgentNativeFeatureSummary[];
  }) {
    this.#installedApps = options.installedApps ?? [];
    this.#availableApps = options.availableApps ?? [];
    this.#mcpServers = options.mcpServers ?? [];
    this.#skills = options.skills ?? [];
    this.#features = options.features ?? [];
  }

  async start(): Promise<void> {}
  async run(): Promise<never> { throw new Error("unused"); }
  async interrupt(): Promise<void> {}
  async stop(): Promise<void> {}

  async listSkills(): Promise<AgentSkillSummary[]> {
    return structuredClone(this.#skills);
  }

  async listInstalledApps(): Promise<AgentAppSummary[]> {
    return structuredClone(this.#installedApps);
  }

  async listAvailableApps(): Promise<AgentAppSummary[]> {
    return structuredClone(this.#availableApps);
  }

  async readApps(): Promise<AgentAppReadResult> {
    return { apps: [], missingAppIds: [] };
  }

  async listNativeExtensionFeatures(): Promise<AgentNativeFeatureSummary[]> {
    return structuredClone(this.#features);
  }

  async listMcpServers(): Promise<AgentMcpServerSummary[]> {
    return structuredClone(this.#mcpServers);
  }
}
