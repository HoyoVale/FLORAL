import { describe, expect, it } from "vitest";
import { ReplyTargetCache } from "../src/transport/qq/reply-target-cache.js";

describe("QQ reply target cache", () => {
  it("returns a target before expiry", () => {
    let now = 1_000;
    const cache = new ReplyTargetCache<string>(5_000, 4, () => now);
    cache.set("conversation", "target", "message");
    expect(cache.get("conversation")).toMatchObject({
      target: "target",
      messageId: "message",
      expiresAt: 6_000,
    });
    now += 1;
    expect(cache.size()).toBe(1);
  });

  it("removes an expired passive reply target", () => {
    let now = 1_000;
    const cache = new ReplyTargetCache<string>(5_000, 4, () => now);
    cache.set("conversation", "target", "message");
    now = 6_000;
    expect(cache.get("conversation")).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  it("replaces the target for a newer message in the same conversation", () => {
    const cache = new ReplyTargetCache<string>(5_000, 4, () => 1_000);
    cache.set("conversation", "old", "old-message");
    cache.set("conversation", "new", "new-message");
    expect(cache.get("conversation")).toMatchObject({
      target: "new",
      messageId: "new-message",
    });
  });

  it("evicts the oldest entry when capacity is exceeded", () => {
    const cache = new ReplyTargetCache<string>(5_000, 2, () => 1_000);
    cache.set("one", "target-1", "message-1");
    cache.set("two", "target-2", "message-2");
    cache.set("three", "target-3", "message-3");
    expect(cache.get("one")).toBeUndefined();
    expect(cache.get("two")).toBeDefined();
    expect(cache.get("three")).toBeDefined();
  });
});
