import { describe, expect, it } from "vitest";
import type { McpRuntimeRegistry } from "../src/config/mcp/mcp-runtime-registry.js";
import { AuthorizationAuthority } from "../src/policy/authorization-authority.js";

function registry(): McpRuntimeRegistry {
  return {
    schemaVersion: 1,
    authorityVersion: 1,
    profile: "test",
    registryFingerprint: "test-only",
    servers: [
      {
        id: "floral_search",
        enabled: true,
        integrationStatus: "active",
        required: true,
        startupTimeoutSec: 60,
        toolTimeoutSec: 45,
        defaultToolsApprovalMode: "approve",
        transport: {
          type: "stdio",
          command: "npx",
          args: ["mcp-searxng"],
          inheritParentEnvironment: false,
          environment: [],
        },
        tools: [{ name: "searxng_web_search", enabled: true, approvalMode: "approve" }],
      },
      {
        id: "floral_peekaboo",
        enabled: true,
        integrationStatus: "active",
        required: false,
        startupTimeoutSec: 60,
        toolTimeoutSec: 45,
        defaultToolsApprovalMode: "prompt",
        transport: {
          type: "stdio",
          command: "node",
          args: ["floral-peekaboo-mcp.js"],
          inheritParentEnvironment: false,
          environment: [],
        },
        tools: [
          { name: "click", enabled: true, approvalMode: "prompt" },
          { name: "image", enabled: true, approvalMode: "approve" },
          { name: "see", enabled: true, approvalMode: "approve" },
        ],
      },
    ],
  };
}

function authority(sandboxMode: "read-only" | "workspace-write" | "danger-full-access") {
  return new AuthorizationAuthority({ enabled: true, sandboxMode, allowRemoteFileChangeApproval: false, mcpRegistry: registry() });
}

describe("AuthorizationAuthority", () => {
  it("intersects role capability and sandbox ceilings before approval", () => {
    const policy = authority("read-only");
    expect(policy.evaluate({
      role: "viewer",
      capability: "files.write",
      source: "codex-file-change",
    })).toMatchObject({ status: "deny", reason: "role-capability-denied" });

    expect(policy.evaluate({
      role: "owner",
      capability: "files.write",
      source: "codex-file-change",
    })).toMatchObject({ status: "deny", reason: "sandbox-capability-denied" });
  });

  it("requires one-shot chat confirmation for writes inside a writable sandbox", () => {
    expect(authority("workspace-write").evaluate({
      role: "owner",
      capability: "files.write",
      source: "codex-file-change",
    })).toEqual({
      status: "approval-required",
      approvalLevel: "chat-confirmation",
      reason: "policy",
    });
  });


  it("allows a one-shot Codex file-change approval without widening the base read-only sandbox", () => {
    const policy = new AuthorizationAuthority({
      enabled: true,
      sandboxMode: "read-only",
      allowRemoteFileChangeApproval: true,
      mcpRegistry: registry(),
    });
    expect(policy.evaluate({
      role: "owner",
      capability: "files.write",
      source: "codex-file-change",
    })).toEqual({
      status: "approval-required",
      approvalLevel: "chat-confirmation",
      reason: "policy",
    });

    expect(policy.evaluate({
      role: "owner",
      capability: "files.write",
      source: "floral",
    })).toMatchObject({ status: "deny", reason: "sandbox-capability-denied" });
  });

  it("trusts Codex to classify native command escalation and requires owner chat confirmation", () => {
    expect(authority("danger-full-access").evaluate({
      role: "owner",
      capability: "shell.execute",
      source: "codex-command",
    })).toEqual({
      status: "approval-required",
      approvalLevel: "chat-confirmation",
      reason: "policy",
    });
  });

  it("allows only the owner to answer a Codex structured permission request", () => {
    expect(authority("workspace-write").evaluate({
      role: "owner",
      capability: "codex.permission.grant",
      source: "codex-permission-request",
    })).toEqual({
      status: "approval-required",
      approvalLevel: "chat-confirmation",
      reason: "policy",
    });

    expect(authority("workspace-write").evaluate({
      role: "operator",
      capability: "codex.permission.grant",
      source: "codex-permission-request",
    })).toMatchObject({
      status: "deny",
      reason: "role-capability-denied",
    });
  });

  it("allows only owner-approved FLORAL Skill supply-chain changes to cross a read-only Codex sandbox", () => {
    expect(authority("read-only").evaluate({
      role: "owner",
      capability: "software.install",
      source: "floral-skill",
    })).toEqual({
      status: "approval-required",
      approvalLevel: "chat-confirmation",
      reason: "policy",
    });

    expect(authority("read-only").evaluate({
      role: "operator",
      capability: "software.install",
      source: "floral-skill",
    })).toMatchObject({
      status: "deny",
      reason: "role-capability-denied",
    });
  });

  it("requires owner chat approval for curated External MCP supply-chain changes", () => {
    expect(authority("read-only").evaluate({
      role: "owner",
      capability: "software.install",
      source: "floral-extension",
    })).toEqual({
      status: "approval-required",
      approvalLevel: "chat-confirmation",
      reason: "policy",
    });
    expect(authority("read-only").evaluate({
      role: "operator",
      capability: "software.install",
      source: "floral-extension",
    })).toMatchObject({ status: "deny", reason: "role-capability-denied" });
  });

  it("routes curated Chrome MCP write approval through browser.submit without broad MCP allowlisting", () => {
    expect(authority("read-only").evaluate({
      role: "owner",
      capability: "browser.submit",
      source: "mcp-tool",
      mcpServerId: "chrome-devtools",
      mcpToolName: "navigate_page",
    })).toEqual({
      status: "approval-required",
      approvalLevel: "chat-confirmation",
      reason: "policy",
    });
    expect(authority("read-only").evaluate({
      role: "owner",
      capability: "browser.submit",
      source: "mcp-tool",
      mcpServerId: "not-curated",
      mcpToolName: "navigate_page",
    })).toMatchObject({ status: "deny", reason: "mcp-tool-not-allowlisted" });
  });

  it("keeps the GitHub owner control plane owner-only", () => {
    expect(authority("danger-full-access").evaluate({
      role: "owner",
      capability: "files.write",
      source: "mcp-tool",
      mcpServerId: "github-owner",
      mcpToolName: "issue_write",
    })).toEqual({
      status: "approval-required",
      approvalLevel: "chat-confirmation",
      reason: "policy",
    });
    expect(authority("danger-full-access").evaluate({
      role: "operator",
      capability: "files.write",
      source: "mcp-tool",
      mcpServerId: "github-owner",
      mcpToolName: "issue_write",
    })).toMatchObject({ status: "deny", reason: "role-capability-denied" });
  });

  it("lets only bounded FLORAL maintenance reach Mac-local restart confirmation across a Codex sandbox", () => {
    expect(authority("read-only").evaluate({
      role: "owner",
      capability: "system.restart",
      source: "floral-maintenance",
    })).toEqual({
      status: "approval-required",
      approvalLevel: "local-confirmation",
      reason: "policy",
    });

    expect(authority("read-only").evaluate({
      role: "owner",
      capability: "system.restart",
      source: "floral",
    })).toMatchObject({ status: "deny", reason: "sandbox-capability-denied" });

    expect(authority("read-only").evaluate({
      role: "operator",
      capability: "system.restart",
      source: "floral-maintenance",
    })).toMatchObject({ status: "deny", reason: "role-capability-denied" });
  });

  it("requires local confirmation for system administration", () => {
    expect(authority("danger-full-access").evaluate({
      role: "owner",
      capability: "system.admin",
      source: "floral",
    })).toEqual({
      status: "approval-required",
      approvalLevel: "local-confirmation",
      reason: "policy",
    });
  });

  it("allows only the exact allowlisted Peekaboo click to cross the read-only sandbox", () => {
    const policy = authority("read-only");
    expect(policy.evaluate({
      role: "owner",
      capability: "application.control",
      source: "mcp-tool",
      mcpServerId: "floral_peekaboo",
      mcpToolName: "click",
    })).toEqual({
      status: "approval-required",
      approvalLevel: "chat-confirmation",
      reason: "policy",
    });

    expect(policy.evaluate({
      role: "owner",
      capability: "application.control",
      source: "floral",
    })).toMatchObject({ status: "deny", reason: "sandbox-capability-denied" });

    expect(policy.evaluate({
      role: "owner",
      capability: "application.control",
      source: "mcp-tool",
      mcpServerId: "floral_peekaboo",
      mcpToolName: "type",
    })).toMatchObject({ status: "deny", reason: "mcp-tool-not-allowlisted" });
  });

  it("fails closed when an active MCP tool has no capability mapping", () => {
    const uncovered = registry();
    uncovered.servers[0]!.tools.push({
      name: "future_unmapped_tool",
      enabled: true,
      approvalMode: "approve",
    });
    expect(() => new AuthorizationAuthority({
      enabled: true,
      sandboxMode: "read-only",
      allowRemoteFileChangeApproval: false,
      mcpRegistry: uncovered,
    })).toThrow(/no FLORAL capability mapping/u);
  });

  it("allows only active allowlisted MCP tools", () => {
    const policy = authority("read-only");
    expect(policy.evaluate({
      role: "owner",
      capability: "web.search",
      source: "mcp-tool",
      mcpServerId: "floral_search",
      mcpToolName: "searxng_web_search",
    })).toEqual({ status: "allow", approvalLevel: "automatic", reason: "automatic" });

    expect(policy.evaluate({
      role: "owner",
      capability: "web.search",
      source: "mcp-tool",
      mcpServerId: "floral_search",
      mcpToolName: "unlisted_tool",
    })).toMatchObject({ status: "deny", reason: "mcp-tool-not-allowlisted" });
  });
});
