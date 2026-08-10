import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteGatewayStore } from "../src/storage/sqlite.js";

describe("SqliteGatewayStore", () => {
  it("persists owner identity, conversation thread, audit, and message receipts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "floral-store-test-"));
    const path = join(directory, "gateway.sqlite");
    const identity = {
      transport: "qq" as const,
      botId: "bot-a",
      externalUserId: "openid-a",
      conversationId: "c2c-a",
      displayName: "Owner",
    };

    try {
      const first = await SqliteGatewayStore.open(path);
      expect(await first.acceptMessage(identity, "message-1", new Date())).toBe(true);
      expect(await first.acceptMessage(identity, "message-1", new Date())).toBe(false);

      const owner = await first.claimOwner(identity);
      expect(owner.role).toBe("owner");
      await first.setActiveThread(owner.conversationId, "thread-persisted");
      await first.setSelectedProject(owner.conversationId, "FLORAL");
      await first.setProjectActiveThread(
        owner.conversationId,
        "FLORAL",
        "thread-project-persisted",
      );
      await first.appendAudit({
        userId: owner.userId,
        conversationId: owner.conversationId,
        eventType: "test.persisted",
        payload: { count: 1 },
      });
      expect(first.diagnostics()).toMatchObject({
        schemaVersion: 6,
        users: 1,
        identities: 1,
        conversations: 1,
        conversationProjects: 1,
        messageReceipts: 1,
        auditEvents: 1,
        owners: 1,
        durableTransactions: 0,
        durableEvents: 0,
        durableRecoverable: 0,
      });
      await first.close();

      const reopened = await SqliteGatewayStore.open(path);
      const resolved = await reopened.resolveIdentity(identity);
      expect(resolved).toMatchObject({
        userId: owner.userId,
        role: "owner",
        conversationId: owner.conversationId,
      });
      expect(
        resolved
          ? await reopened.getActiveThread(resolved.conversationId)
          : undefined,
      ).toBe("thread-persisted");
      expect(
        resolved
          ? await reopened.getSelectedProject(resolved.conversationId)
          : undefined,
      ).toBe("FLORAL");
      expect(
        resolved
          ? await reopened.getProjectActiveThread(
              resolved.conversationId,
              "FLORAL",
            )
          : undefined,
      ).toBe("thread-project-persisted");

      await reopened.clearActiveThread(owner.conversationId);
      expect(await reopened.getActiveThread(owner.conversationId)).toBeUndefined();
      await reopened.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("allows only one owner per transport and bot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "floral-owner-test-"));
    const path = join(directory, "gateway.sqlite");
    const store = await SqliteGatewayStore.open(path);

    try {
      await store.claimOwner({
        transport: "qq",
        botId: "bot-a",
        externalUserId: "owner-a",
        conversationId: "conversation-a",
      });

      await expect(store.claimOwner({
        transport: "qq",
        botId: "bot-a",
        externalUserId: "owner-b",
        conversationId: "conversation-b",
      })).rejects.toThrow("already has an owner");

      await expect(store.claimOwner({
        transport: "qq",
        botId: "bot-b",
        externalUserId: "owner-b",
        conversationId: "conversation-b",
      })).resolves.toMatchObject({ role: "owner" });
    } finally {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses separate internal conversations for the same owner in different chats", async () => {
    const directory = await mkdtemp(join(tmpdir(), "floral-conversation-test-"));
    const path = join(directory, "gateway.sqlite");
    const store = await SqliteGatewayStore.open(path);

    const firstIdentity = {
      transport: "qq" as const,
      botId: "bot-a",
      externalUserId: "owner-a",
      conversationId: "conversation-a",
    };

    try {
      const first = await store.claimOwner(firstIdentity);
      const second = await store.resolveIdentity({
        ...firstIdentity,
        conversationId: "conversation-b",
      });

      expect(second?.userId).toBe(first.userId);
      expect(second?.conversationId).not.toBe(first.conversationId);
      expect(store.diagnostics().conversations).toBe(2);
    } finally {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("persists owner conversation control mode and removes the default ask state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "floral-mode-state-"));
    const path = join(directory, "gateway.sqlite");
    try {
      const first = await SqliteGatewayStore.open(path);
      const owner = await first.claimOwner({
        transport: "feishu",
        botId: "bot-mode",
        externalUserId: "owner-mode",
        conversationId: "chat-mode",
      });
      await first.setConversationControlMode(owner.conversationId, "full");
      await first.close();

      const reopened = await SqliteGatewayStore.open(path);
      await expect(reopened.getConversationControlMode(owner.conversationId)).resolves.toBe("full");
      await reopened.setConversationControlMode(owner.conversationId, "ask");
      await expect(reopened.getConversationControlMode(owner.conversationId)).resolves.toBeUndefined();
      await reopened.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects oversized audit payloads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "floral-audit-test-"));
    const path = join(directory, "gateway.sqlite");
    const store = await SqliteGatewayStore.open(path);

    try {
      await expect(store.appendAudit({
        eventType: "test.large",
        payload: { value: "x".repeat(20_000) },
      })).rejects.toThrow("exceeds");
    } finally {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
