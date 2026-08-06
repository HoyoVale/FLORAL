import { describe, expect, it } from "vitest";
import {
  BridgeConcurrencyGate,
} from "../src/agent/bridge/concurrency-gate.js";

describe("BridgeConcurrencyGate", () => {
  it("grants within capacity and releases idempotently", async () => {
    const gate = new BridgeConcurrencyGate(1, 1, 100);
    const release = await gate.acquire();
    expect(gate.snapshot()).toMatchObject({ active: 1, queued: 0 });
    release();
    release();
    expect(gate.snapshot()).toMatchObject({ active: 0, queued: 0 });
  });

  it("queues and grants the next request after release", async () => {
    const gate = new BridgeConcurrencyGate(1, 1, 100);
    const firstRelease = await gate.acquire();
    const second = gate.acquire();
    expect(gate.snapshot()).toMatchObject({ active: 1, queued: 1 });
    firstRelease();
    const secondRelease = await second;
    expect(gate.snapshot()).toMatchObject({ active: 1, queued: 0 });
    secondRelease();
  });

  it("fails closed when the queue is full", async () => {
    const gate = new BridgeConcurrencyGate(1, 0, 100);
    const release = await gate.acquire();
    await expect(gate.acquire()).rejects.toMatchObject({
      kind: "queue_full",
    });
    release();
  });

  it("removes a queued request after timeout", async () => {
    const gate = new BridgeConcurrencyGate(1, 1, 10);
    const release = await gate.acquire();
    await expect(gate.acquire()).rejects.toMatchObject({
      kind: "queue_timeout",
    });
    expect(gate.snapshot()).toMatchObject({ active: 1, queued: 0 });
    release();
  });
});
