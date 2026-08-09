import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CodexAppServerRuntime,
  type CodexSystemAwarenessOptions,
} from "../src/agent/codex-app-server.js";
import { CodexRuntimeError } from "../src/agent/codex-errors.js";
import type { AgentEvent } from "../src/core/types.js";
import {
  SYSTEM_AWARENESS_SCHEMA_VERSION,
  createDefaultSystemDefinitionRegistry,
} from "../src/system-awareness/index.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url));

function createRuntime(
  scenario: string,
  timeoutMs = 5_000,
  options: {
    approvalPolicy?: "never" | "on-request" | "untrusted";
    sandboxMode?: "read-only" | "workspace-write";
    approvalsReviewer?: "user" | "auto_review";
    skillRoots?: string[];
    protectedSkillRoots?: string[];
    externalSkillCatalog?: () => Promise<string>;
    manageExternalSkill?: (request: {
      action: "install" | "update" | "enable" | "disable" | "remove";
      id: string;
      ref?: string | undefined;
    }) => Promise<{ changed: boolean; message: string }>;
    externalMcpCatalog?: () => Promise<string>;
    manageExternalMcp?: (request: {
      action: "install" | "enable" | "disable" | "remove";
      id: "github-readonly" | "chrome-devtools";
    }) => Promise<{
      changed: boolean;
      message: string;
      registry: {
        version: 1;
        packages: Array<{
          id: "github-readonly" | "chrome-devtools";
          enabled: boolean;
          installedAt: string;
          updatedAt: string;
        }>;
      };
    }>;
    permissionProfile?: string;
    permissionProfileCwd?: string;
    systemAwareness?: CodexSystemAwarenessOptions;
  } = {},
): CodexAppServerRuntime {
  return new CodexAppServerRuntime({
    command: process.execPath,
    args: [fixture, scenario],
    requestTimeoutMs: timeoutMs,
    defaultModel: undefined,
    ...options,
  });
}

describe("CodexAppServerRuntime", () => {
  it("runs a new thread and trusts item/completed as final text", async () => {
    const runtime = createRuntime("normal");
    const events: AgentEvent[] = [];
    try {
      await runtime.start();
      const result = await runtime.run(
        { text: "hello", cwd: process.cwd() },
        (event) => events.push(event),
      );

      expect(result).toEqual({ threadId: "thr_new", finalText: "authoritative final" });
      expect(events.some((event) => event.type === "assistant.delta")).toBe(true);
      expect(events.at(-1)?.type).toBe("run.completed");
    } finally {
      await runtime.stop();
    }
  });

  it("registers FLORAL skill roots and lists Codex-discovered skills", async () => {
    const skillRoot = new URL("../skills/", import.meta.url);
    const runtime = createRuntime("normal", 5_000, {
      skillRoots: [fileURLToPath(skillRoot)],
    });
    try {
      await runtime.start();
      const skills = await runtime.listSkills({
        cwd: process.cwd(),
        forceReload: true,
      });
      expect(skills.map((skill) => skill.name)).toEqual([
        "system-status",
        "attachment-analysis",
        "macos-ui-operation",
        "skill-manager",
        "extension-manager",
      ]);
      expect(skills.every((skill) => skill.enabled)).toBe(true);
      expect(skills[0]?.path).toMatch(/system-status[\\/]SKILL\.md$/u);
    } finally {
      await runtime.stop();
    }
  });

  it("adds the official skill input item for an explicit $skill-name invocation", async () => {
    const skillRoot = new URL("../skills/", import.meta.url);
    const runtime = createRuntime("skills-explicit", 5_000, {
      skillRoots: [fileURLToPath(skillRoot)],
    });
    try {
      await runtime.start();
      const result = await runtime.run({
        text: "$system-status check the host",
        cwd: process.cwd(),
      });
      expect(result.finalText).toBe("authoritative final");
    } finally {
      await runtime.stop();
    }
  });

  it("adds the official skill input item for explicit $macos-ui-operation", async () => {
    const skillRoot = new URL("../skills/", import.meta.url);
    const runtime = createRuntime("skills-explicit", 5_000, {
      skillRoots: [fileURLToPath(skillRoot)],
    });
    try {
      await runtime.start();
      const result = await runtime.run({
        text: "$macos-ui-operation inspect the frontmost Mac app safely",
        cwd: process.cwd(),
      });
      expect(result.finalText).toBe("authoritative final");
    } finally {
      await runtime.stop();
    }
  });

  it("uses native skills/config/write for a non-builtin Skill requested by the Agent", async () => {
    const builtInRoot = fileURLToPath(
      new URL("../skills/", import.meta.url),
    );
    const externalRoot = resolve(
      process.cwd(),
      "data",
      "test-external-skills",
    );
    const runtime = createRuntime("skill-control-disable", 5_000, {
      skillRoots: [builtInRoot, externalRoot],
      protectedSkillRoots: [builtInRoot],
    });
    try {
      await runtime.start();
      const result = await runtime.run({
        text: "Disable brainstorming for this Project.",
        cwd: process.cwd(),
      });
      expect(result.finalText).toBe("skill disable complete");

      const skills = await runtime.listSkills({
        cwd: process.cwd(),
        forceReload: true,
      });
      expect(
        skills.find(
          (skill) => skill.name === "superpowers:brainstorming",
        )?.enabled,
      ).toBe(false);
    } finally {
      await runtime.stop();
    }
  });

  it("requires approval before Agent-initiated shared External Skill installation", async () => {
    const builtInRoot = fileURLToPath(
      new URL("../skills/", import.meta.url),
    );
    let approvals = 0;
    let mutations = 0;
    const runtime = createRuntime("skill-external-install", 5_000, {
      skillRoots: [builtInRoot],
      protectedSkillRoots: [builtInRoot],
      externalSkillCatalog: async () =>
        "external_skill_catalog.count=1\nid=superpowers installed=false enabled=false",
      manageExternalSkill: async (request) => {
        mutations += 1;
        expect(request).toEqual({
          action: "install",
          id: "superpowers",
        });
        return {
          changed: true,
          message: "external_skills.install=ok\nid=superpowers",
        };
      },
    });

    try {
      await runtime.start();
      const result = await runtime.run({
        text: "Install Superpowers.",
        cwd: process.cwd(),
        skillManagementApprovalHandler: async (request) => {
          approvals += 1;
          expect(request).toMatchObject({
            kind: "skill-management",
            capability: "software.install",
            source: "floral",
          });
          return "approve";
        },
      });
      expect(result.finalText).toBe("external skill install complete");
      expect(approvals).toBe(1);
      expect(mutations).toBe(1);
    } finally {
      await runtime.stop();
    }
  });

  it("adds the official skill input item for explicit namespaced external Skills", async () => {
    const builtInRoot = fileURLToPath(
      new URL("../skills/", import.meta.url),
    );
    const externalRoot = resolve(
      process.cwd(),
      "data",
      "test-external-skills",
    );
    const runtime = createRuntime("skills-explicit", 5_000, {
      skillRoots: [builtInRoot, externalRoot],
    });
    try {
      await runtime.start();
      const result = await runtime.run({
        text: "$superpowers:brainstorming explore the design",
        cwd: process.cwd(),
      });
      expect(result.finalText).toBe("authoritative final");
    } finally {
      await runtime.stop();
    }
  });

  it("selects a Codex-native project permission profile instead of legacy sandboxPolicy", async () => {
    const runtime = createRuntime("project-permissions", 5_000, {
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write",
      permissionProfile: "floral-project",
      permissionProfileCwd: process.cwd(),
    });
    try {
      await runtime.start();
      const result = await runtime.run({ text: "read project only", cwd: process.cwd() });
      expect(result.finalText).toBe("authoritative final");
    } finally {
      await runtime.stop();
    }
  });

  it("fails closed when the configured Codex permission profile is unavailable", async () => {
    const runtime = createRuntime("permission-profile-missing", 5_000, {
      permissionProfile: "floral-project",
      permissionProfileCwd: process.cwd(),
    });
    try {
      await expect(runtime.start()).rejects.toThrow(/permission profile is not available/u);
    } finally {
      await runtime.stop();
    }
  });

  it("injects the FLORAL routing policy as developer instructions", async () => {
    const runtime = createRuntime("developer-instructions");
    try {
      await runtime.start();
      const result = await runtime.run({ text: "hello", cwd: process.cwd() });
      expect(result.finalText).toBe("authoritative final");
    } finally {
      await runtime.stop();
    }
  });

  it("exposes FLORAL generic artifact delivery as client-hosted dynamic tools", async () => {
    const runtime = createRuntime("delivery-dynamic-tools");
    try {
      await runtime.start();
      const result = await runtime.run({ text: "hello", cwd: process.cwd() });
      expect(result.finalText).toBe("authoritative final");
    } finally {
      await runtime.stop();
    }
  });

  it("discovers Codex Apps and native extension feature state without Plugin catalog RPCs", async () => {
    const runtime = createRuntime("normal");
    try {
      await runtime.start();
      await expect(runtime.listInstalledApps({
        cwd: process.cwd(),
        forceRefresh: false,
      })).resolves.toEqual([
        {
          id: "github",
          runtimeName: "GitHub",
          enabled: true,
          callable: true,
          source: "installed-runtime",
        },
        {
          id: "disabled-app",
          runtimeName: "Disabled App",
          enabled: false,
          callable: false,
          source: "installed-runtime",
        },
      ]);
      await expect(runtime.listAvailableApps({
        cwd: process.cwd(),
        forceRefresh: false,
      })).resolves.toEqual([
        {
          id: "github",
          runtimeName: "GitHub",
          description: "GitHub connector directory entry",
          installUrl: "https://chatgpt.com/apps/github/github",
          enabled: true,
          accessible: true,
          source: "directory",
        },
        {
          id: "calendar-demo",
          runtimeName: "Calendar Demo",
          description: "Directory-only inaccessible example",
          installUrl: "https://chatgpt.com/apps/calendar-demo/calendar-demo",
          enabled: false,
          accessible: false,
          source: "directory",
        },
      ]);
      await expect(runtime.readApps({
        cwd: process.cwd(),
        appIds: ["github", "missing"],
        includeTools: true,
      })).resolves.toEqual({
        apps: [{
          id: "github",
          name: "GitHub",
          description: "Work with GitHub repositories and pull requests.",
          pluginDisplayNames: ["GitHub"],
          tools: [{
            name: "search_repositories",
            title: "Search repositories",
            description: "Search GitHub repositories.",
            enabled: true,
            readOnly: true,
          }],
        }],
        missingAppIds: ["missing"],
      });
      await expect(runtime.listNativeExtensionFeatures({
        cwd: process.cwd(),
      })).resolves.toEqual([
        { name: "apps", stage: "beta", enabled: true, defaultEnabled: true },
        {
          name: "plugins",
          stage: "underDevelopment",
          enabled: true,
          defaultEnabled: false,
        },
      ]);
    } finally {
      await runtime.stop();
    }
  });

  it("falls back to app/list without inventing callable state when app/installed is unsupported", async () => {
    const runtime = createRuntime("app-installed-fallback");
    try {
      await runtime.start();
      await expect(runtime.listInstalledApps({
        cwd: process.cwd(),
      })).resolves.toEqual([
        {
          id: "github",
          runtimeName: "GitHub",
          description: "GitHub connector directory entry",
          installUrl: "https://chatgpt.com/apps/github/github",
          enabled: true,
          accessible: true,
          source: "directory-fallback",
        },
        {
          id: "calendar-demo",
          runtimeName: "Calendar Demo",
          description: "Directory-only inaccessible example",
          installUrl: "https://chatgpt.com/apps/calendar-demo/calendar-demo",
          enabled: false,
          accessible: false,
          source: "directory-fallback",
        },
      ]);
    } finally {
      await runtime.stop();
    }
  });

  it("treats discovered MCP tools as ready when status/list omits startup status", async () => {
    const runtime = createRuntime("normal");
    try {
      await runtime.start();
      await expect(runtime.listMcpServers({
        cwd: process.cwd(),
      })).resolves.toEqual([
        {
          name: "github",
          status: "ready",
          authStatus: "authenticated",
          tools: [{ name: "search_repositories", readOnly: true }],
        },
        {
          name: "chrome-devtools",
          status: "ready",
          authStatus: "not-required",
          tools: [
            { name: "navigate_page", readOnly: false },
            { name: "take_screenshot", readOnly: true },
          ],
        },
      ]);
    } finally {
      await runtime.stop();
    }
  });

  it("injects a Codex App mention for an explicit accessible $app token", async () => {
    const runtime = createRuntime("app-mention");
    try {
      await runtime.start();
      const result = await runtime.run({
        text: "$github inspect this repository",
        cwd: process.cwd(),
      });
      expect(result.finalText).toBe("authoritative final");
    } finally {
      await runtime.stop();
    }
  });

  it("exposes a pre-captured read-only System Awareness snapshot without nested runtime RPC", async () => {
    const registry = createDefaultSystemDefinitionRegistry();
    let snapshotReads = 0;
    const runtime = createRuntime("system-awareness", 5_000, {
      systemAwareness: {
        definitions: registry.list(),
        snapshotProvider: async () => {
          snapshotReads += 1;
          return {
            schemaVersion: SYSTEM_AWARENESS_SCHEMA_VERSION,
            generatedAt: "2026-08-10T00:00:00.000Z",
            definitionFingerprint: registry.fingerprint(),
            components: registry.list().map((definition) => ({
              componentId: definition.id,
              observed: definition.id === "floral.service",
              facts: definition.id === "floral.service"
                ? [{
                    fact: "recorded.phase",
                    resolution: "resolved" as const,
                    confidence: "authoritative" as const,
                    value: "ready",
                    evidence: [],
                  }]
                : [],
            })),
            observers: [{
              observerId: "fixture",
              status: "ok" as const,
              observedAt: "2026-08-10T00:00:00.000Z",
              evidenceCount: 1,
            }],
          };
        },
      },
    });
    try {
      await runtime.start();
      const result = await runtime.run({
        text: "Describe your current system state.",
        cwd: process.cwd(),
      });
      expect(result.finalText).toBe("system awareness complete");
      expect(snapshotReads).toBe(1);
    } finally {
      await runtime.stop();
    }
  });

  it("exposes read-only FLORAL extension discovery as client-hosted dynamic tools", async () => {
    const runtime = createRuntime("extension-installed-apps");
    try {
      await runtime.start();
      const result = await runtime.run({
        text: "Check installed Codex Apps.",
        cwd: process.cwd(),
      });
      expect(result.finalText).toBe("extension apps complete");
    } finally {
      await runtime.stop();
    }
  });

  it("exposes the Codex App directory separately from installed runtime state", async () => {
    const runtime = createRuntime("extension-available-apps");
    try {
      await runtime.start();
      const result = await runtime.run({
        text: "Show available Codex Apps.",
        cwd: process.cwd(),
      });
      expect(result.finalText).toBe("extension available apps complete");
    } finally {
      await runtime.stop();
    }
  });

  it("prepares a supported App installation handoff without silently installing or authenticating", async () => {
    const runtime = createRuntime("extension-app-install-handoff");
    try {
      await runtime.start();
      const result = await runtime.run({
        text: "Prepare GitHub App installation.",
        cwd: process.cwd(),
      });
      expect(result.finalText).toBe("extension app handoff complete");
    } finally {
      await runtime.stop();
    }
  });

  it("exposes per-turn MCP status through floral_extensions without nested RPC", async () => {
    const runtime = createRuntime("extension-mcp-status");
    try {
      await runtime.start();
      const result = await runtime.run({
        text: "Check MCP status.",
        cwd: process.cwd(),
      });
      expect(result.finalText).toBe("extension mcp status complete");
    } finally {
      await runtime.stop();
    }
  });

  it("requires one-shot approval before Agent-managed shared MCP installation", async () => {
    let approvals = 0;
    let mutations = 0;
    const runtime = createRuntime("extension-mcp-install", 5_000, {
      externalMcpCatalog: async () =>
        "external_mcp_catalog.count=2\nid=chrome-devtools installed=false",
      manageExternalMcp: async (request) => {
        mutations += 1;
        expect(request).toEqual({
          action: "install",
          id: "chrome-devtools",
        });
        return {
          changed: true,
          message: "external_mcp.install=ok\nid=chrome-devtools",
          registry: {
            version: 1,
            packages: [{
              id: "chrome-devtools",
              enabled: true,
              installedAt: "2026-08-10T00:00:00.000Z",
              updatedAt: "2026-08-10T00:00:00.000Z",
            }],
          },
        };
      },
    });
    try {
      await runtime.start();
      const result = await runtime.run({
        text: "Install the curated Chrome MCP.",
        cwd: process.cwd(),
        extensionManagementApprovalHandler: async (request) => {
          approvals += 1;
          expect(request).toMatchObject({
            kind: "extension-management",
            capability: "software.install",
            source: "floral",
          });
          return "approve";
        },
      });
      expect(result.finalText).toBe("extension mcp install complete");
      expect(approvals).toBe(1);
      expect(mutations).toBe(1);
    } finally {
      await runtime.stop();
    }
  });

  it("marks same-turn MCP status as stale after a managed MCP mutation", async () => {
    const runtime = createRuntime("extension-mcp-install-status-pending", 5_000, {
      externalMcpCatalog: async () =>
        "external_mcp_catalog.count=2\nid=chrome-devtools installed=false",
      manageExternalMcp: async () => ({
        changed: true,
        message: "external_mcp.install=ok\nid=chrome-devtools",
        registry: {
          version: 1,
          packages: [{
            id: "chrome-devtools",
            enabled: true,
            installedAt: "2026-08-10T00:00:00.000Z",
            updatedAt: "2026-08-10T00:00:00.000Z",
          }],
        },
      }),
    });
    try {
      await runtime.start();
      const result = await runtime.run({
        text: "Install and verify Chrome MCP safely.",
        cwd: process.cwd(),
        extensionManagementApprovalHandler: async () => "approve",
      });
      expect(result.finalText).toBe("extension mcp verification deferred safely");
    } finally {
      await runtime.stop();
    }
  });

  it("declines shell/config verification after a managed MCP mutation without delegating a second approval", async () => {
    const runtime = createRuntime("extension-mcp-install-shell-verification", 5_000, {
      externalMcpCatalog: async () =>
        "external_mcp_catalog.count=2\nid=chrome-devtools installed=false",
      manageExternalMcp: async () => ({
        changed: true,
        message: "external_mcp.install=ok\nid=chrome-devtools",
        registry: {
          version: 1,
          packages: [{
            id: "chrome-devtools",
            enabled: true,
            installedAt: "2026-08-10T00:00:00.000Z",
            updatedAt: "2026-08-10T00:00:00.000Z",
          }],
        },
      }),
    });
    let shellApprovals = 0;
    try {
      await runtime.start();
      const result = await runtime.run({
        text: "Install Chrome MCP and do not bypass the control plane.",
        cwd: process.cwd(),
        extensionManagementApprovalHandler: async () => "approve",
        approvalHandler: async () => {
          shellApprovals += 1;
          return "approve";
        },
      });
      expect(result.finalText).toContain("这不代表安装失败");
      expect(result.finalText).toContain(
        "下一回合使用 floral_extensions/mcp_status",
      );
      expect(shellApprovals).toBe(0);
    } finally {
      await runtime.stop();
    }
  });

  it("resumes an existing thread before starting a turn", async () => {
    const runtime = createRuntime("resume");
    try {
      await runtime.start();
      const result = await runtime.run({
        threadId: "thr_existing",
        text: "continue",
        cwd: process.cwd(),
      });
      expect(result).toEqual({ threadId: "thr_existing", finalText: "resumed final" });
    } finally {
      await runtime.stop();
    }
  });

  it("starts a fresh thread when a persisted thread is no longer available", async () => {
    const runtime = createRuntime("stale-resume");
    try {
      await runtime.start();
      const result = await runtime.run({
        threadId: "thr_deleted",
        text: "recover",
        cwd: process.cwd(),
      });
      expect(result).toEqual({
        threadId: "thr_new",
        finalText: "recovered final",
      });
    } finally {
      await runtime.stop();
    }
  });

  it("does not reset a thread when -32600 is a configuration failure", async () => {
    const runtime = createRuntime("resume-config-error");
    try {
      await runtime.start();
      await expect(runtime.run({
        threadId: "thr_existing",
        text: "continue",
        cwd: process.cwd(),
      })).rejects.toMatchObject({
        name: "CodexRuntimeError",
        method: "thread/resume",
        code: -32600,
      });
    } finally {
      await runtime.stop();
    }
  });

  it("declines approvals by default", async () => {
    const runtime = createRuntime("approval");
    const events: AgentEvent[] = [];
    try {
      await runtime.start();
      const result = await runtime.run(
        { text: "run command", cwd: process.cwd() },
        (event) => events.push(event),
      );

      expect(result.finalText).toBe("approval declined safely");
      expect(events.some((event) => event.type === "approval.requested")).toBe(true);
    } finally {
      await runtime.stop();
    }
  });

  it("forwards a bounded approval request to the run-scoped handler", async () => {
    const runtime = createRuntime("approval");
    const events: AgentEvent[] = [];
    try {
      await runtime.start();
      const result = await runtime.run(
        {
          text: "run command",
          cwd: process.cwd(),
          approvalHandler: async (request) => {
            expect(request).toMatchObject({
              kind: "command-execution",
              capability: "shell.execute",
              source: "codex",
            });
            expect(request.summary).toContain("echo unsafe");
            expect(request.summary).toContain("--token <redacted>");
            expect(request.summary).not.toContain("supersecret");
            return "approve";
          },
        },
        (event) => events.push(event),
      );

      expect(result.finalText).toBe("approval accepted safely");
      expect(events).toContainEqual(expect.objectContaining({
        type: "approval.requested",
        capability: "shell.execute",
        kind: "command-execution",
      }));
    } finally {
      await runtime.stop();
    }
  });



  it("declines shell GUI automation bypasses without delegating them for approval", async () => {
    const runtime = createRuntime("gui-shell-bypass");
    let approvalCalls = 0;
    const events: AgentEvent[] = [];
    try {
      await runtime.start();
      const result = await runtime.run(
        {
          text: "click through shell",
          cwd: process.cwd(),
          approvalHandler: async () => {
            approvalCalls += 1;
            return "approve";
          },
        },
        (event) => events.push(event),
      );
      expect(result.finalText).toBe("gui shell bypass declined safely");
      expect(approvalCalls).toBe(0);
      expect(events.some((event) => event.type === "approval.requested")).toBe(false);
    } finally {
      await runtime.stop();
    }
  });

  it("keeps thread bootstrap minimal and applies approval/sandbox at turn scope", async () => {
    const runtime = createRuntime("on-request-file-approval", 5_000, {
      approvalPolicy: "untrusted",
      sandboxMode: "workspace-write",
      approvalsReviewer: "user",
    });
    try {
      await runtime.start();
      const result = await runtime.run({
        text: "edit one file",
        cwd: ".",
        approvalHandler: async (request) => {
          expect(request).toMatchObject({
            kind: "file-change",
            capability: "files.write",
            source: "codex",
          });
          expect(request.summary).toContain("update:src/example.ts");
          expect(request.summary).not.toContain("not-for-approval");
          return "approve";
        },
      });
      expect(result.finalText).toBe("approval accepted safely");
    } finally {
      await runtime.stop();
    }
  });

  it("supports a run-scoped Codex auto_review reviewer", async () => {
    const runtime = createRuntime("auto-review");
    try {
      await runtime.start();
      const result = await runtime.run({
        text: "work autonomously",
        cwd: process.cwd(),
        approvalsReviewer: "auto_review",
      });
      expect(result.finalText).toBe("auto review configured");
    } finally {
      await runtime.stop();
    }
  });

  it("grants an exact Codex permission request for one turn", async () => {
    const runtime = createRuntime("permission-approval");
    try {
      await runtime.start();
      const result = await runtime.run({
        text: "request permission",
        cwd: process.cwd(),
        approvalHandler: async (request) => {
          expect(request).toMatchObject({
            kind: "permission-request",
            capability: "codex.permission.grant",
            source: "codex",
          });
          expect(request.summary).toContain("network");
          expect(request.summary).toContain("/tmp/shared");
          return "approve";
        },
      });
      expect(result.finalText).toBe("permission approval accepted safely");
    } finally {
      await runtime.stop();
    }
  });

  it("uses Codex native session scope for approved permission requests", async () => {
    const runtime = createRuntime("permission-session-approval");
    try {
      await runtime.start();
      const result = await runtime.run({
        text: "request session permission",
        cwd: process.cwd(),
        approvalHandler: async () => "approve-session",
      });
      expect(result.finalText).toBe("permission session approval accepted safely");
    } finally {
      await runtime.stop();
    }
  });


  it("emits bounded MCP tool lifecycle events", async () => {
    const runtime = createRuntime("mcp-tool");
    const events: AgentEvent[] = [];
    try {
      await runtime.start();
      const result = await runtime.run(
        { text: "search", cwd: process.cwd() },
        (event) => events.push(event),
      );

      expect(result.finalText).toBe("search complete");
      expect(events).toContainEqual({
        type: "tool.started",
        name: "floral_search/searxng_web_search",
        detail: {
          server: "floral_search",
          tool: "searxng_web_search",
          status: "inProgress",
        },
      });
      expect(events).toContainEqual({
        type: "tool.completed",
        name: "floral_search/searxng_web_search",
        detail: {
          server: "floral_search",
          tool: "searxng_web_search",
          status: "completed",
        },
      });
    } finally {
      await runtime.stop();
    }
  });

  it("registers a trusted Peekaboo artifact from the completed MCP result", async () => {
    const runtime = createRuntime("mcp-artifact");
    const events: AgentEvent[] = [];
    try {
      await runtime.start();
      const result = await runtime.run(
        { text: "capture", cwd: process.cwd() },
        (event) => events.push(event),
      );
      expect(result.finalText).toBe("artifact captured");
      expect(events).toContainEqual({
        type: "artifact.registered",
        artifact: {
          id: "artifact-screen-fixture",
          kind: "image",
          localPath: "/tmp/floral-screen.png",
          source: {
            type: "mcp",
            serverId: "floral_peekaboo",
            toolName: "image",
          },
        },
      });
    } finally {
      await runtime.stop();
    }
  });

  it("delegates register_outbound_file to the run-scoped artifact handler", async () => {
    const runtime = createRuntime("delivery-register");
    try {
      await runtime.start();
      const result = await runtime.run({
        text: "register report",
        cwd: process.cwd(),
        artifactRegistrationHandler: async (request) => {
          expect(request).toEqual({
            localPath: "/tmp/outbound/report.txt",
            fileName: "report.txt",
          });
          return {
            status: "registered",
            artifactId: "artifact-file-fixture",
          };
        },
      });
      expect(result.finalText).toBe("delivery register complete");
    } finally {
      await runtime.stop();
    }
  });

  it("delegates send_artifact and returns transport-confirmed success to the model", async () => {
    const runtime = createRuntime("delivery-send");
    try {
      await runtime.start();
      const result = await runtime.run({
        text: "send screenshot",
        cwd: process.cwd(),
        artifactDeliveryHandler: async (request) => {
          expect(request).toEqual({
            artifactId: "artifact-screen-fixture",
            caption: "current screen",
          });
          return {
            status: "sent",
            artifactId: request.artifactId,
            kind: "image",
            byteLength: 123,
          };
        },
      });
      expect(result.finalText).toBe("delivery send complete");
    } finally {
      await runtime.stop();
    }
  });

  it("delegates a trusted MCP click approval to the FLORAL approval handler", async () => {
    const runtime = createRuntime("mcp-approval");
    const events: AgentEvent[] = [];
    try {
      await runtime.start();
      const result = await runtime.run(
        {
          text: "expand src",
          cwd: process.cwd(),
          approvalHandler: async (request) => {
            expect(request).toMatchObject({
              kind: "mcp-tool",
              capability: "application.control",
              source: "mcp",
              mcpServerId: "floral_peekaboo",
              mcpToolName: "click",
            });
            expect(request.summary).toContain("展开 VS Code 的 src 文件夹");
            return "approve";
          },
        },
        (event) => events.push(event),
      );
      expect(result.finalText).toBe("mcp approval accepted safely");
      expect(events).toContainEqual(expect.objectContaining({
        type: "approval.requested",
        capability: "application.control",
        kind: "mcp-tool",
      }));
    } finally {
      await runtime.stop();
    }
  });

  it("routes curated Chrome MCP write approval through the dedicated MCP handler", async () => {
    const runtime = createRuntime("external-mcp-approval");
    try {
      await runtime.start();
      const result = await runtime.run({
        text: "Navigate the browser.",
        cwd: process.cwd(),
        mcpToolApprovalHandler: async (request) => {
          expect(request).toMatchObject({
            kind: "mcp-tool",
            capability: "browser.submit",
            source: "mcp",
            mcpServerId: "chrome-devtools",
            mcpToolName: "navigate_page",
          });
          expect(request.summary).toContain("https://example.com");
          return "approve";
        },
      });
      expect(result.finalText).toBe("mcp approval accepted safely");
    } finally {
      await runtime.stop();
    }
  });

  it("declines an MCP click when no FLORAL approval handler is available", async () => {
    const runtime = createRuntime("mcp-approval");
    try {
      await runtime.start();
      const result = await runtime.run({ text: "expand src", cwd: process.cwd() });
      expect(result.finalText).toBe("mcp approval declined safely");
    } finally {
      await runtime.stop();
    }
  });

  it("prefers the terminal final answer over an earlier commentary message", async () => {
    const runtime = createRuntime("terminal-final-after-commentary");
    try {
      await runtime.start();
      const result = await runtime.run({
        text: "inspect then summarize",
        cwd: process.cwd(),
      });

      expect(result.finalText).toBe(
        "FLORAL 当前处于 Phase 5.4 QQ Conversation UX 阶段。",
      );
    } finally {
      await runtime.stop();
    }
  });

  it("does not return a pre-tool commentary message when the turn has no final answer", async () => {
    const runtime = createRuntime("tool-after-commentary-without-final");
    try {
      await runtime.start();
      await expect(runtime.run({
        text: "search then summarize",
        cwd: process.cwd(),
      })).rejects.toMatchObject({
        name: "CodexRuntimeError",
        kind: "protocol",
      });
    } finally {
      await runtime.stop();
    }
  });

  it("invalidates an unphased pre-tool fallback after later work starts", async () => {
    const runtime = createRuntime("unphased-message-before-tool-without-final");
    try {
      await runtime.start();
      await expect(runtime.run({
        text: "inspect then answer",
        cwd: process.cwd(),
      })).rejects.toMatchObject({
        name: "CodexRuntimeError",
        kind: "protocol",
      });
    } finally {
      await runtime.stop();
    }
  });

  it("surfaces provider usage limits as a typed error", async () => {
    const runtime = createRuntime("quota");
    try {
      await runtime.start();
      await expect(runtime.run({ text: "hello", cwd: process.cwd() })).rejects.toMatchObject({
        name: "CodexRuntimeError",
        kind: "usage_limit",
        retryable: false,
      });
    } finally {
      await runtime.stop();
    }
  });

  it("times out a stalled turn and attempts interruption", async () => {
    const runtime = createRuntime("timeout", 500);
    try {
      await runtime.start();
      await expect(runtime.run({ text: "hang", cwd: process.cwd() })).rejects.toMatchObject({
        kind: "request_timeout",
      });
    } finally {
      await runtime.stop();
    }
  });

  it("surfaces an unexpected app-server exit", async () => {
    const runtime = createRuntime("exit-turn");
    try {
      await runtime.start();
      let caught: unknown;
      try {
        await runtime.run({ text: "exit", cwd: process.cwd() });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(CodexRuntimeError);
      expect(caught).toMatchObject({ kind: "process_exit" });
      expect((caught as Error).message).toContain("fixture forced exit");
    } finally {
      await runtime.stop();
    }
  });
});
