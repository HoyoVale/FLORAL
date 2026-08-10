import { randomUUID } from "node:crypto";
import type {
  GoalContinuationRecord,
  GoalContinuationStore,
  GatewayStore,
  WorkspaceStateStore,
} from "../core/contracts.js";
import type {
  AuditEventInput,
  ExternalIdentity,
  GatewayRole,
  ResolvedGatewayIdentity,
  TransportKind,
} from "../core/types.js";

interface StoredUserIdentity {
  userId: string;
  role: GatewayRole;
  transport: TransportKind;
  botId: string;
  externalUserId: string;
}

interface StoredConversation {
  userId: string;
  conversationId: string;
}

export class MemoryThreadStore
  implements GatewayStore, WorkspaceStateStore, GoalContinuationStore
{
  readonly #threads = new Map<string, string>();
  readonly #selectedProjects = new Map<string, string>();
  readonly #projectThreads = new Map<string, string>();
  readonly #identities = new Map<string, StoredUserIdentity>();
  readonly #conversations = new Map<string, StoredConversation>();
  readonly #messages = new Set<string>();
  readonly #audits: AuditEventInput[] = [];
  readonly #goalContinuations = new Map<string, GoalContinuationRecord>();

  async resolveIdentity(
    identity: ExternalIdentity,
  ): Promise<ResolvedGatewayIdentity | undefined> {
    const stored = this.#identities.get(identityKey(identity));
    if (!stored) return undefined;
    const conversation = this.#ensureConversation(stored.userId, identity);
    return {
      userId: stored.userId,
      role: stored.role,
      conversationId: conversation.conversationId,
    };
  }

  async claimOwner(identity: ExternalIdentity): Promise<ResolvedGatewayIdentity> {
    const key = identityKey(identity);
    const existing = this.#identities.get(key);
    if (existing) {
      const conversation = this.#ensureConversation(existing.userId, identity);
      return {
        userId: existing.userId,
        role: existing.role,
        conversationId: conversation.conversationId,
      };
    }

    const alreadyOwned = [...this.#identities.values()].some((candidate) =>
      candidate.transport === identity.transport
      && candidate.botId === identity.botId
      && candidate.role === "owner"
    );
    if (alreadyOwned) {
      throw new Error("This bot already has an owner");
    }

    const stored: StoredUserIdentity = {
      userId: randomUUID(),
      role: "owner",
      transport: identity.transport,
      botId: identity.botId,
      externalUserId: identity.externalUserId,
    };
    this.#identities.set(key, stored);
    const conversation = this.#ensureConversation(stored.userId, identity);
    return {
      userId: stored.userId,
      role: stored.role,
      conversationId: conversation.conversationId,
    };
  }

  async hasOwner(transport: TransportKind, botId: string): Promise<boolean> {
    return [...this.#identities.values()].some((identity) =>
      identity.transport === transport
      && identity.botId === botId
      && identity.role === "owner"
    );
  }

  async acceptMessage(
    identity: ExternalIdentity,
    messageId: string,
  ): Promise<boolean> {
    const key = `${identity.transport}\u0000${identity.botId}\u0000${messageId}`;
    if (this.#messages.has(key)) return false;
    this.#messages.add(key);
    return true;
  }

  async getActiveThread(conversationId: string): Promise<string | undefined> {
    return this.#threads.get(conversationId);
  }

  async setActiveThread(conversationId: string, threadId: string): Promise<void> {
    this.#threads.set(conversationId, threadId);
  }

  async clearActiveThread(conversationId: string): Promise<void> {
    this.#threads.delete(conversationId);
  }

  async getSelectedProject(conversationId: string): Promise<string | undefined> {
    return this.#selectedProjects.get(conversationId);
  }

  async setSelectedProject(
    conversationId: string,
    projectName: string,
  ): Promise<void> {
    this.#selectedProjects.set(conversationId, projectName);
  }

  async getProjectActiveThread(
    conversationId: string,
    projectName: string,
  ): Promise<string | undefined> {
    return this.#projectThreads.get(projectThreadKey(conversationId, projectName));
  }

  async setProjectActiveThread(
    conversationId: string,
    projectName: string,
    threadId: string,
  ): Promise<void> {
    this.#projectThreads.set(
      projectThreadKey(conversationId, projectName),
      threadId,
    );
  }

  async clearProjectActiveThread(
    conversationId: string,
    projectName: string,
  ): Promise<void> {
    this.#projectThreads.delete(projectThreadKey(conversationId, projectName));
  }

  async appendAudit(event: AuditEventInput): Promise<void> {
    this.#audits.push(structuredClone(event));
  }

  async loadGoalContinuation(
    conversationId: string,
  ): Promise<GoalContinuationRecord | undefined> {
    const stored = this.#goalContinuations.get(conversationId);
    return stored ? structuredClone(stored) : undefined;
  }

  async saveGoalContinuation(record: GoalContinuationRecord): Promise<void> {
    this.#goalContinuations.set(conversationId(record), structuredClone(record));
  }

  async deleteGoalContinuation(conversationId: string): Promise<void> {
    this.#goalContinuations.delete(conversationId);
  }

  async listGoalContinuations(): Promise<GoalContinuationRecord[]> {
    return [...this.#goalContinuations.values()]
      .map((record) => structuredClone(record))
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  auditEvents(): readonly AuditEventInput[] {
    return this.#audits;
  }

  async close(): Promise<void> {}

  #ensureConversation(
    userId: string,
    identity: ExternalIdentity,
  ): StoredConversation {
    const key = conversationKey(identity);
    const existing = this.#conversations.get(key);
    if (existing) {
      if (existing.userId !== userId) {
        throw new Error("Conversation is already assigned to another user");
      }
      return existing;
    }
    const created = { userId, conversationId: randomUUID() };
    this.#conversations.set(key, created);
    return created;
  }
}

function identityKey(identity: ExternalIdentity): string {
  return [
    identity.transport,
    identity.botId,
    identity.externalUserId,
  ].join("\u0000");
}

function conversationKey(identity: ExternalIdentity): string {
  return [
    identity.transport,
    identity.botId,
    identity.conversationId,
  ].join("\u0000");
}

function projectThreadKey(conversationId: string, projectName: string): string {
  return `${conversationId}\u0000${projectName}`;
}

function conversationId(record: GoalContinuationRecord): string {
  return record.conversationId;
}
