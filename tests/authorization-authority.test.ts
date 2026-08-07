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
    ],
  };
}

function authority(sandboxMode: "read-only" | "workspace-write" | "danger-full-access") {
  return new AuthorizationAuthority({ enabled: true, sandboxMode, mcpRegistry: registry() });
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

  it("never turns an opaque Codex command escalation into a remote QQ approval", () => {
    expect(authority("danger-full-access").evaluate({
      role: "owner",
      capability: "shell.execute",
      source: "codex-command",
    })).toEqual({
      status: "approval-required",
      approvalLevel: "local-confirmation",
      reason: "policy",
    });
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
