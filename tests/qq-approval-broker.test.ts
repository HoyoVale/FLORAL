import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AuditEventInput } from "../src/core/types.js";
import type { McpRuntimeRegistry } from "../src/config/mcp/mcp-runtime-registry.js";
import { AuthorizationAuthority } from "../src/policy/authorization-authority.js";
import { QqApprovalBroker } from "../src/policy/qq-approval-broker.js";
import { LocalConfirmationBroker, writeLocalApprovalDecision } from "../src/policy/local-confirmation-broker.js";

function writableAuthority(): AuthorizationAuthority {
  const registry: McpRuntimeRegistry = {
    schemaVersion: 1,
    authorityVersion: 1,
    profile: "test",
    registryFingerprint: "test-only",
    servers: [],
  };
  return new AuthorizationAuthority({
    enabled: true,
    sandboxMode: "workspace-write",
    allowRemoteFileChangeApproval: false,
    mcpRegistry: registry,
  });
}

describe("QqApprovalBroker", () => {
  it("binds an approval to owner, conversation, request, and one-shot use", async () => {
    const sent: string[] = [];
    const audits: AuditEventInput[] = [];
    const broker = new QqApprovalBroker({
      ttlMs: 5_000,
      maxPending: 4,
      ownerOnly: true,
      authority: writableAuthority(),
      send: async (_conversationId, text) => { sent.push(text); },
      audit: async (event) => { audits.push(event); },
      createPublicId: () => "ABC12345",
    });
    const scope = {
      userId: "owner-1",
      role: "owner" as const,
      conversationId: "conversation-1",
      deliveryConversationId: "qq-conversation-1",
    };
    const decisionPromise = broker.request(scope, {
      requestId: "codex-private-id",
      kind: "file-change",
      capability: "files.write",
      summary: "修改项目中的一个文件",
      source: "codex",
    });

    await Promise.resolve();
    expect(sent.at(-1)).toContain("审批编号=ABC12345");
    expect(JSON.stringify(audits)).not.toContain("codex-private-id");

    await expect(broker.resolve({
      userId: "owner-1",
      role: "owner",
      conversationId: "different-conversation",
    }, "ABC12345", "approve")).resolves.toBe("not-authorized");

    await expect(broker.resolve({
      userId: "owner-1",
      role: "owner",
      conversationId: "conversation-1",
    }, "ABC12345", "approve")).resolves.toBe("approved");
    await expect(decisionPromise).resolves.toBe("approve");

    await expect(broker.resolve({
      userId: "owner-1",
      role: "owner",
      conversationId: "conversation-1",
    }, "ABC12345", "approve")).resolves.toBe("not-found");
  });

  it("returns a Codex-native session approval without a FLORAL command allowlist", async () => {
    const broker = new QqApprovalBroker({
      ttlMs: 5_000,
      maxPending: 4,
      ownerOnly: true,
      authority: writableAuthority(),
      send: async () => undefined,
      audit: async () => undefined,
      createPublicId: () => "SESSION77",
    });
    const scope = {
      userId: "owner-1",
      role: "owner" as const,
      conversationId: "conversation-1",
      deliveryConversationId: "qq-conversation-1",
    };
    const decisionPromise = broker.request(scope, {
      requestId: "codex-session",
      kind: "command-execution",
      capability: "shell.execute",
      summary: "git status",
      source: "codex",
    });
    await Promise.resolve();

    await expect(
      broker.resolve(scope, "SESSION77", "approve-session"),
    ).resolves.toBe("approved-session");
    await expect(decisionPromise).resolves.toBe("approve-session");
    expect(broker.pendingCount()).toBe(0);
  });


  it("keeps shared Skill supply-chain approval one-shot even when approve-session is requested", async () => {
    const interactive: Array<{ allowSession?: boolean | undefined }> = [];
    const broker = new QqApprovalBroker({
      ttlMs: 5_000,
      maxPending: 4,
      ownerOnly: true,
      authority: writableAuthority(),
      send: async () => undefined,
      sendInteractive: async (prompt) => {
        interactive.push({ allowSession: prompt.allowSession });
      },
      audit: async () => undefined,
      createPublicId: () => "SKILL777",
    });
    const scope = {
      userId: "owner-1",
      role: "owner" as const,
      conversationId: "conversation-1",
      deliveryConversationId: "qq-conversation-1",
    };
    const decisionPromise = broker.request(scope, {
      requestId: "skill-private",
      kind: "skill-management",
      capability: "extension.install",
      summary: "Install shared External Skill superpowers",
      source: "floral",
      scope: {
        type: "extension",
        extensionKind: "skill",
        targetId: "superpowers",
        action: "install",
        sourceId: "obra/superpowers",
        sourceVersion: "pinned-test-commit",
        permissions: ["files.read"],
      },
    });
    await Promise.resolve();

    expect(interactive).toEqual([{ allowSession: false }]);
    await expect(
      broker.resolve(scope, "SKILL777", "approve-session"),
    ).resolves.toBe("not-authorized");
    expect(broker.pendingCount()).toBe(1);

    await expect(
      broker.resolve(scope, "SKILL777", "approve"),
    ).resolves.toBe("approved");
    await expect(decisionPromise).resolves.toBe("approve");
  });

  it("prefers an interactive one-shot prompt and keeps the approval ID out of text", async () => {
    const sent: string[] = [];
    const interactive: Array<{ approvalId: string; capability: string; summary: string }> = [];
    const broker = new QqApprovalBroker({
      ttlMs: 5_000,
      maxPending: 4,
      ownerOnly: true,
      authority: writableAuthority(),
      send: async (_conversationId, text) => { sent.push(text); },
      sendInteractive: async (prompt) => {
        interactive.push({
          approvalId: prompt.approvalId,
          capability: prompt.capability,
          summary: prompt.summary,
        });
      },
      audit: async () => undefined,
      createPublicId: () => "BUTTON123",
    });
    const scope = {
      userId: "owner-1",
      role: "owner" as const,
      conversationId: "conversation-1",
      deliveryConversationId: "qq-conversation-1",
    };

    const decisionPromise = broker.request(scope, {
      requestId: "req-button",
      kind: "file-change",
      capability: "files.write",
      summary: "modify phase54b-test.txt",
      source: "codex",
    });
    await Promise.resolve();

    expect(sent).toEqual([]);
    expect(interactive).toEqual([{
      approvalId: "BUTTON123",
      capability: "files.write",
      summary: "modify phase54b-test.txt",
    }]);
    await expect(broker.resolve(scope, "BUTTON123", "approve")).resolves.toBe("approved");
    await expect(decisionPromise).resolves.toBe("approve");
  });

  it("falls back to the existing command prompt when native keyboard delivery fails", async () => {
    const sent: string[] = [];
    let resolveFallbackSent!: () => void;
    const fallbackSent = new Promise<void>((resolve) => {
      resolveFallbackSent = resolve;
    });
    const broker = new QqApprovalBroker({
      ttlMs: 5_000,
      maxPending: 4,
      ownerOnly: true,
      authority: writableAuthority(),
      send: async (_conversationId, text) => {
        sent.push(text);
        resolveFallbackSent();
      },
      sendInteractive: async () => { throw new Error("keyboard unavailable"); },
      audit: async () => undefined,
      createPublicId: () => "FALLBACK1",
    });
    const scope = {
      userId: "owner-1",
      role: "owner" as const,
      conversationId: "conversation-1",
      deliveryConversationId: "qq-conversation-1",
    };

    const decisionPromise = broker.request(scope, {
      requestId: "req-fallback",
      kind: "file-change",
      capability: "files.write",
      summary: "write",
      source: "codex",
    });
    await fallbackSent;

    expect(sent.at(-1)).toContain("审批编号=FALLBACK1");
    expect(sent.at(-1)).toContain("/approve FALLBACK1");
    await expect(broker.resolve(scope, "FALLBACK1", "deny")).resolves.toBe("denied");
    await expect(decisionPromise).resolves.toBe("deny");
  });

  it("requires the owner role for remote approval prompts", async () => {
    const sent: string[] = [];
    const broker = new QqApprovalBroker({
      ttlMs: 5_000,
      maxPending: 4,
      ownerOnly: true,
      authority: writableAuthority(),
      send: async (_conversationId, text) => { sent.push(text); },
      audit: async () => undefined,
    });

    await expect(broker.request({
      userId: "operator-1",
      role: "operator",
      conversationId: "conversation-1",
      deliveryConversationId: "qq-conversation-1",
    }, {
      requestId: "req-operator",
      kind: "file-change",
      capability: "files.write",
      summary: "write",
      source: "codex",
    })).resolves.toBe("deny");
    expect(sent).toHaveLength(0);
    expect(broker.pendingCount()).toBe(0);
  });

  it("consumes an explicit denial exactly once", async () => {
    const broker = new QqApprovalBroker({
      ttlMs: 5_000,
      maxPending: 2,
      ownerOnly: true,
      authority: writableAuthority(),
      send: async () => undefined,
      audit: async () => undefined,
      createPublicId: () => "DENY1234",
    });
    const scope = {
      userId: "owner-1",
      role: "owner" as const,
      conversationId: "conversation-1",
      deliveryConversationId: "qq-conversation-1",
    };
    const result = broker.request(scope, {
      requestId: "req-deny",
      kind: "file-change",
      capability: "files.write",
      summary: "write",
      source: "codex",
    });
    await Promise.resolve();
    await expect(broker.resolve(scope, "DENY1234", "deny")).resolves.toBe("denied");
    await expect(result).resolves.toBe("deny");
    await expect(broker.resolve(scope, "DENY1234", "approve")).resolves.toBe("not-found");
  });

  it("expires pending approvals fail-closed", async () => {
    const broker = new QqApprovalBroker({
      ttlMs: 20,
      maxPending: 1,
      ownerOnly: true,
      authority: writableAuthority(),
      send: async () => undefined,
      audit: async () => undefined,
      createPublicId: () => "EXP12345",
    });
    const decision = await broker.request({
      userId: "owner-1",
      role: "owner",
      conversationId: "conversation-1",
      deliveryConversationId: "qq-conversation-1",
    }, {
      requestId: "req-1",
      kind: "file-change",
      capability: "files.write",
      summary: "write",
      source: "codex",
    });
    expect(decision).toBe("deny");
    expect(broker.pendingCount()).toBe(0);
  });

  it("invalidates pending approvals when the service stops or restarts", async () => {
    const broker = new QqApprovalBroker({
      ttlMs: 5_000,
      maxPending: 2,
      ownerOnly: true,
      authority: writableAuthority(),
      send: async () => undefined,
      audit: async () => undefined,
      createPublicId: () => "RST12345",
    });
    const decisionPromise = broker.request({
      userId: "owner-1",
      role: "owner",
      conversationId: "conversation-1",
      deliveryConversationId: "qq-conversation-1",
    }, {
      requestId: "req-restart",
      kind: "file-change",
      capability: "files.write",
      summary: "write",
      source: "codex",
    });
    await Promise.resolve();
    expect(broker.pendingCount()).toBe(1);
    broker.cancelAll();
    await expect(decisionPromise).resolves.toBe("deny");
    expect(broker.pendingCount()).toBe(0);
  });


  it("routes local-confirmation approvals through the Mac-local one-shot broker", async () => {
    const sent: string[] = [];
    let resolveDelivery!: (text: string) => void;
    const delivery = new Promise<string>((resolve) => {
      resolveDelivery = resolve;
    });
    const registry: McpRuntimeRegistry = {
      schemaVersion: 1,
      authorityVersion: 1,
      profile: "test",
      registryFingerprint: "test-only",
      servers: [],
    };
    const directory = await mkdtemp(join(tmpdir(), "floral-qq-local-approval-"));
    const localConfirmation = new LocalConfirmationBroker({
      directory,
      ttlMs: 5_000,
      pollIntervalMs: 50,
      maxPending: 4,
      enabled: true,
      createPublicId: () => "LOCAL777",
    });
    await localConfirmation.initialize();
    let interactiveCalls = 0;
    const broker = new QqApprovalBroker({
      ttlMs: 5_000,
      maxPending: 4,
      ownerOnly: true,
      authority: new AuthorizationAuthority({
        enabled: true,
        sandboxMode: "danger-full-access",
        allowRemoteFileChangeApproval: false,
        mcpRegistry: registry,
      }),
      localConfirmation,
      sendInteractive: async () => { interactiveCalls += 1; },
      send: async (_conversationId, text) => {
        sent.push(text);
        resolveDelivery(text);
      },
      audit: async () => undefined,
    });

    const decision = broker.request({
      userId: "owner-1",
      role: "owner",
      conversationId: "conversation-1",
      deliveryConversationId: "qq-conversation-1",
    }, {
      requestId: "req-local",
      kind: "command-execution",
      capability: "system.admin",
      summary: "system administration",
      source: "codex",
    });

    const prompt = await delivery;
    expect(interactiveCalls).toBe(0);
    expect(prompt).toContain("本地审批编号=LOCAL777");
    expect(prompt).toContain("请求详情仅在 Mac 本地显示");
    expect(prompt).not.toContain("system administration");
    expect(prompt).toContain("远程 /approve 无法授权");
    expect(broker.pendingCount("conversation-1")).toBe(1);
    expect(await writeLocalApprovalDecision(directory, "LOCAL777", "approve")).toBe("written");
    await expect(decision).resolves.toBe("approve");
    expect(broker.pendingCount("conversation-1")).toBe(0);
  });

  it("refuses to remote-approve a local-confirmation capability", async () => {
    const sent: string[] = [];
    const registry: McpRuntimeRegistry = {
      schemaVersion: 1,
      authorityVersion: 1,
      profile: "test",
      registryFingerprint: "test-only",
      servers: [],
    };
    const broker = new QqApprovalBroker({
      ttlMs: 5_000,
      maxPending: 4,
      ownerOnly: true,
      authority: new AuthorizationAuthority({
        enabled: true,
        sandboxMode: "danger-full-access",
        allowRemoteFileChangeApproval: false,
        mcpRegistry: registry,
      }),
      send: async (_conversationId, text) => { sent.push(text); },
      audit: async () => undefined,
    });

    await expect(broker.request({
      userId: "owner-1",
      role: "owner",
      conversationId: "conversation-1",
      deliveryConversationId: "qq-conversation-1",
    }, {
      requestId: "req-1",
      kind: "command-execution",
      capability: "system.admin",
      summary: "sudo something",
      source: "codex",
    })).resolves.toBe("deny");
    expect(sent.at(-1)).toContain("Mac 本地确认");
    expect(broker.pendingCount()).toBe(0);
  });
  it("lets host trusted-owner policy auto-approve a chat-confirmation without creating a pending prompt", async () => {
    const sent: string[] = [];
    const audits: AuditEventInput[] = [];
    const broker = new QqApprovalBroker({
      ttlMs: 5_000,
      maxPending: 4,
      ownerOnly: true,
      authority: writableAuthority(),
      send: async (_conversationId, text) => { sent.push(text); },
      audit: async (event) => { audits.push(event); },
      autoApproveChatConfirmation: async (scope, request) => ({
        approved: scope.role === "owner" && request.capability === "extension.install",
        reason: "trusted-owner-full",
      }),
    });

    await expect(broker.request({
      userId: "owner-1",
      role: "owner",
      conversationId: "conversation-1",
      deliveryConversationId: "qq-conversation-1",
    }, {
      requestId: "extension-private",
      kind: "extension-management",
      capability: "extension.install",
      summary: "Install curated MCP",
      source: "floral",
      scope: {
        type: "extension",
        extensionKind: "mcp",
        targetId: "chrome-devtools",
        action: "install",
        sourceId: "npm:@modelcontextprotocol/server-chrome-devtools",
        sourceVersion: "1.0.0",
        permissions: ["browser.inspect"],
      },
    })).resolves.toBe("approve");

    expect(sent).toEqual([]);
    expect(broker.pendingCount()).toBe(0);
    expect(audits).toContainEqual(expect.objectContaining({
      eventType: "authorization.trusted_owner_auto_approved",
    }));
  });

});
