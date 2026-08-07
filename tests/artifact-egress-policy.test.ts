import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactEgressPolicy } from "../src/policy/artifact-egress-policy.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "floral-artifact-egress-"));
  temporary.push(dir);
  const root = join(dir, "outbound");
  const policy = new ArtifactEgressPolicy({
    enabled: true,
    allowedRoots: [root],
    allowedMcpProducers: ["floral_peekaboo/image", "floral_peekaboo/see"],
    allowedFloralCapabilities: [],
    maxArtifactsPerRun: 2,
    maxBytesPerRun: 32,
  });
  await policy.initialize();
  return { dir, root, policy };
}

describe("ArtifactEgressPolicy", () => {
  it("allows an owner screenshot only from an allowlisted producer and root", async () => {
    const { root, policy } = await fixture();
    const screenshot = join(root, "screen.png");
    await writeFile(screenshot, Buffer.from([1, 2, 3, 4]));

    const budget = policy.createRunBudget();
    const result = await policy.authorizeAndReserve({
      role: "owner",
      budget,
      artifact: {
        id: "artifact-screen-1",
        kind: "image",
        localPath: screenshot,
        source: {
          type: "mcp",
          serverId: "floral_peekaboo",
          toolName: "image",
        },
        caption: "**current screen**",
      },
    });

    expect(result).toMatchObject({
      status: "allow",
      sourceCapability: "screen.capture",
      byteLength: 4,
      media: {
        kind: "image",
        localPath: resolve(screenshot),
        caption: "**current screen**",
      },
    });
    expect(budget.artifactCount).toBe(1);
    expect(budget.byteCount).toBe(4);
  });

  it("separates capture permission from outbound message permission", async () => {
    const { root, policy } = await fixture();
    const screenshot = join(root, "screen.png");
    await writeFile(screenshot, "screen");

    const result = await policy.authorizeAndReserve({
      role: "operator",
      budget: policy.createRunBudget(),
      artifact: {
        id: "artifact-screen-2",
        kind: "image",
        localPath: screenshot,
        source: {
          type: "mcp",
          serverId: "floral_peekaboo",
          toolName: "image",
        },
      },
    });

    expect(result).toEqual({
      status: "deny",
      reason: "message-send-role-denied",
    });
  });

  it("fails closed for an unallowlisted producer or path outside the egress root", async () => {
    const { dir, root, policy } = await fixture();
    const inside = join(root, "screen.png");
    const outside = join(dir, "outside.png");
    await writeFile(inside, "inside");
    await writeFile(outside, "outside");

    await expect(policy.authorizeAndReserve({
      role: "owner",
      budget: policy.createRunBudget(),
      artifact: {
        id: "artifact-unknown-producer",
        kind: "image",
        localPath: inside,
        source: {
          type: "mcp",
          serverId: "unknown",
          toolName: "capture",
        },
      },
    })).resolves.toEqual({
      status: "deny",
      reason: "producer-not-allowlisted",
    });

    await expect(policy.authorizeAndReserve({
      role: "owner",
      budget: policy.createRunBudget(),
      artifact: {
        id: "artifact-outside",
        kind: "image",
        localPath: outside,
        source: {
          type: "mcp",
          serverId: "floral_peekaboo",
          toolName: "image",
        },
      },
    })).resolves.toEqual({
      status: "deny",
      reason: "path-outside-allowed-root",
    });
  });

  it("enforces duplicate, count, and byte budgets per run", async () => {
    const { root, policy } = await fixture();
    const first = join(root, "first.png");
    const second = join(root, "second.png");
    const third = join(root, "third.png");
    await writeFile(first, "1234");
    await writeFile(second, "5678");
    await writeFile(third, "x".repeat(30));

    const budget = policy.createRunBudget();
    const artifact = (id: string, localPath: string) => ({
      id,
      kind: "image" as const,
      localPath,
      source: {
        type: "mcp" as const,
        serverId: "floral_peekaboo",
        toolName: "image",
      },
    });

    expect((await policy.authorizeAndReserve({
      role: "owner",
      budget,
      artifact: artifact("a1", first),
    })).status).toBe("allow");

    await expect(policy.authorizeAndReserve({
      role: "owner",
      budget,
      artifact: artifact("a1", first),
    })).resolves.toEqual({
      status: "deny",
      reason: "duplicate-artifact",
    });

    expect((await policy.authorizeAndReserve({
      role: "owner",
      budget,
      artifact: artifact("a2", second),
    })).status).toBe("allow");

    await expect(policy.authorizeAndReserve({
      role: "owner",
      budget,
      artifact: artifact("a3", third),
    })).resolves.toEqual({
      status: "deny",
      reason: "run-artifact-limit",
    });
  });
});
