import { describe, expect, it } from "vitest";
import type {
  AgentStatusSnapshot,
  StatusCardTransport,
} from "../src/core/contracts.js";
import type { AuditEventInput } from "../src/core/types.js";
import { AgentStatusCardController } from "../src/service/agent-status-card-controller.js";

class FakeStatusTransport implements StatusCardTransport {
  readonly sent: Array<{ conversationId: string; snapshot: AgentStatusSnapshot }> = [];
  readonly updated: AgentStatusSnapshot[] = [];
  pinned: string[] = [];
  unpinned: string[] = [];
  failUpdate = false;

  async sendStatusCard(
    conversationId: string,
    snapshot: AgentStatusSnapshot,
  ): Promise<{ messageId: string }> {
    this.sent.push({ conversationId, snapshot });
    return { messageId: `card-${String(this.sent.length)}` };
  }

  async updateStatusCard(
    _messageId: string,
    snapshot: AgentStatusSnapshot,
  ): Promise<void> {
    if (this.failUpdate) throw new Error("update failed");
    this.updated.push(snapshot);
  }

  async pinStatusCard(messageId: string): Promise<void> {
    this.pinned.push(messageId);
  }

  async unpinStatusCard(messageId: string): Promise<void> {
    this.unpinned.push(messageId);
  }
}

function harness() {
  let now = 0;
  const timers: Array<{ at: number; fn: () => Promise<void>; handle: number }> = [];
  const audits: AuditEventInput[] = [];
  const transport = new FakeStatusTransport();
  const canceled = new Set<number>();
  let nextHandle = 1;
  const controller = new AgentStatusCardController({
    transport,
    audit: async (event) => {
      audits.push(event);
    },
    enabled: true,
    updateIntervalMs: 5,
    autoPin: true,
    now: () => now,
    schedule: (fn, delay) => {
      const handle = nextHandle;
      nextHandle += 1;
      timers.push({
        at: now + delay,
        fn: async () => {
          await fn();
        },
        handle,
      });
      return handle;
    },
    cancelSchedule: (handle) => {
      canceled.add(handle as number);
    },
  });
  return {
    transport,
    controller,
    audits,
    timers,
    async advance(ms: number): Promise<void> {
      now += ms;
      const due = timers.splice(0).filter((timer) =>
        timer.at <= now && !canceled.has(timer.handle));
      for (const timer of due) await timer.fn();
    },
  };
}

const snapshot: AgentStatusSnapshot = {
  state: "running",
  turnNumber: 1,
  elapsedMs: 0,
};

describe("AgentStatusCardController", () => {
  it("sends, pins, and periodically updates a status card while running", async () => {
    const h = harness();
    await h.controller.start();
    await h.controller.onRunStarted("chat-1", snapshot);

    expect(h.transport.sent).toHaveLength(1);
    expect(h.transport.pinned).toEqual(["card-1"]);

    await h.controller.onRunEvent("chat-1", {
      ...snapshot,
      lastActivity: "working",
    });
    await h.advance(6);
    expect(h.transport.updated).toHaveLength(1);
    expect(h.transport.updated[0]?.lastActivity).toBe("working");

    await h.advance(5);
    expect(h.transport.updated.length).toBeGreaterThanOrEqual(2);
  });

  it("unpins and stops updating after a stopped state", async () => {
    const h = harness();
    await h.controller.start();
    await h.controller.onRunStarted("chat-1", snapshot);
    await h.controller.onStopped("chat-1", { ...snapshot, state: "stopped" });

    expect(h.transport.unpinned).toEqual(["card-1"]);
    const updatedCount = h.transport.updated.length;
    await h.advance(100);
    expect(h.transport.updated.length).toBe(updatedCount);
  });

  it("records card failures without throwing into the run path", async () => {
    const h = harness();
    h.transport.failUpdate = true;
    await h.controller.start();
    await h.controller.onRunStarted("chat-1", snapshot);
    await h.advance(6);
    await h.controller.onRunEvent("chat-1", snapshot);
    expect(h.audits.some((event) => event.eventType === "feishu.status_card_failed"))
      .toBe(true);
  });
});
