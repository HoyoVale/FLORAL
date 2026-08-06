import { describe, expect, it } from "vitest";
import type { ChatTransport, GatewayStore } from "../src/core/contracts.js";
import type {
  AuditEventInput,
  ExternalIdentity,
  IncomingMessage,
  OutgoingMessage,
  ResolvedGatewayIdentity,
  TransportKind,
} from "../src/core/types.js";
import {
  FullChainObservedStore,
  FullChainObservedTransport,
} from "../src/service/full-chain-acceptance.js";

class FakeStore implements GatewayStore {
  thread: string | undefined;
  async resolveIdentity(): Promise<ResolvedGatewayIdentity | undefined> { return undefined; }
  async claimOwner(): Promise<ResolvedGatewayIdentity> {
    return { userId: "u", role: "owner", conversationId: "c" };
  }
  async hasOwner(_transport: TransportKind, _botId: string): Promise<boolean> { return false; }
  async acceptMessage(_identity: ExternalIdentity, _messageId: string, _receivedAt: Date): Promise<boolean> { return true; }
  async getActiveThread(): Promise<string | undefined> { return this.thread; }
  async setActiveThread(_conversationId: string, threadId: string): Promise<void> { this.thread = threadId; }
  async clearActiveThread(): Promise<void> { this.thread = undefined; }
  async appendAudit(_event: AuditEventInput): Promise<void> {}
  async close(): Promise<void> {}
}

class FakeTransport implements ChatTransport {
  readonly name = "fake";
  sent: OutgoingMessage[] = [];
  async start(_onMessage: (message: IncomingMessage) => Promise<void>): Promise<void> {}
  async send(message: OutgoingMessage): Promise<void> { this.sent.push(message); }
  async stop(): Promise<void> {}
}

describe("full-chain acceptance observers", () => {
  it("records owner pairing and successful thread persistence", async () => {
    const store = new FullChainObservedStore(new FakeStore());
    await store.claimOwner({ transport: "qq", botId: "b", externalUserId: "u", conversationId: "c" });
    await store.appendAudit({ eventType: "agent.run_requested" });
    await store.getActiveThread("c");
    await store.setActiveThread("c", "thread-1");
    await store.appendAudit({ eventType: "agent.run_completed" });
    expect(store.snapshot()).toMatchObject({
      ownerPaired: true,
      runRequested: true,
      runCompleted: true,
      runFailed: false,
      threadAfterRun: "thread-1",
    });
  });

  it("captures a pre-existing thread for restart evidence", async () => {
    const base = new FakeStore();
    base.thread = "thread-existing";
    const store = new FullChainObservedStore(base);
    await store.appendAudit({ eventType: "agent.run_requested" });
    await store.getActiveThread("c");
    await store.setActiveThread("c", "thread-existing");
    expect(store.snapshot().threadBeforeRun).toBe("thread-existing");
  });

  it("resolves only after the exact marker is delivered", async () => {
    const base = new FakeTransport();
    const transport = new FullChainObservedTransport(base, "MARKER");
    await transport.send({ conversationId: "c", text: "not marker" });
    expect(transport.snapshot().markerDelivered).toBe(false);
    await transport.send({ conversationId: "c", text: " MARKER " });
    await expect(transport.waitForMarker(100)).resolves.toBeUndefined();
    expect(transport.snapshot().markerDelivered).toBe(true);
  });

  it("times out without a marker", async () => {
    const transport = new FullChainObservedTransport(new FakeTransport(), "MARKER");
    await expect(transport.waitForMarker(10)).rejects.toThrow("timed out");
  });
});
