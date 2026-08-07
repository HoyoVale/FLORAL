import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LocalConfirmationBroker,
  listLocalApprovalRecords,
  writeLocalApprovalDecision,
} from "../src/policy/local-confirmation-broker.js";

function request() {
  return {
    requestId: "codex-private-1",
    kind: "command-execution" as const,
    capability: "shell.execute" as const,
    summary: "Run echo --token supersecret locally",
    source: "codex" as const,
  };
}

const scope = {
  userId: "owner-1",
  role: "owner" as const,
  conversationId: "conversation-1",
};

describe("LocalConfirmationBroker", () => {
  it("writes a private pending record and consumes one local decision", async () => {
    const directory = await mkdtemp(join(tmpdir(), "floral-local-approval-"));
    const broker = new LocalConfirmationBroker({
      directory,
      ttlMs: 5_000,
      pollIntervalMs: 50,
      maxPending: 4,
      enabled: true,
      createPublicId: () => "LOCAL001",
      createSessionId: () => "session-current",
    });
    await broker.initialize();

    const handle = await broker.request(scope, request());
    expect(handle?.notice.publicId).toBe("LOCAL001");
    const records = await listLocalApprovalRecords(directory);
    expect(records).toHaveLength(1);
    expect(records[0]?.summary).toContain("--token <redacted>");
    expect(records[0]?.summary).not.toContain("supersecret");
    expect(JSON.stringify(records[0])).not.toContain("codex-private-1");

    if (process.platform !== "win32") {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(join(directory, "pending-LOCAL001.json"))).mode & 0o777).toBe(0o600);
    }

    expect(await writeLocalApprovalDecision(directory, "LOCAL001", "approve")).toBe("written");
    expect(await writeLocalApprovalDecision(directory, "LOCAL001", "deny")).toBe("already-decided");
    await expect(handle?.decision).resolves.toBe("approve");
    expect(broker.pendingCount()).toBe(0);
    expect(await listLocalApprovalRecords(directory)).toEqual([]);
  });

  it("rejects a forged decision that does not match the pending session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "floral-local-approval-"));
    const broker = new LocalConfirmationBroker({
      directory,
      ttlMs: 5_000,
      pollIntervalMs: 50,
      maxPending: 4,
      enabled: true,
      createPublicId: () => "LOCAL002",
      createSessionId: () => "session-current",
    });
    await broker.initialize();
    const handle = await broker.request(scope, request());
    const record = (await listLocalApprovalRecords(directory))[0];
    expect(record).toBeDefined();

    await writeFile(join(directory, "decision-LOCAL002.json"), `${JSON.stringify({
      schemaVersion: 1,
      publicId: "LOCAL002",
      sessionId: "old-session",
      requestFingerprint: record?.requestFingerprint,
      decision: "approve",
      decidedAt: new Date().toISOString(),
    })}\n`, "utf8");

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(broker.pendingCount()).toBe(1);
    expect(await writeLocalApprovalDecision(directory, "LOCAL002", "approve")).toBe("written");
    await expect(handle?.decision).resolves.toBe("approve");
  });

  it("removes stale files when a new gateway session initializes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "floral-local-approval-"));
    await writeFile(join(directory, "pending-OLD001.json"), "{}\n", "utf8");
    await writeFile(join(directory, "decision-OLD001.json"), "{}\n", "utf8");

    const broker = new LocalConfirmationBroker({
      directory,
      ttlMs: 5_000,
      pollIntervalMs: 50,
      maxPending: 4,
      enabled: true,
    });
    await broker.initialize();
    expect(await listLocalApprovalRecords(directory)).toEqual([]);
  });

  it("fails closed when a pending record expires before local approval", async () => {
    const directory = await mkdtemp(join(tmpdir(), "floral-local-approval-"));
    let now = 1_000_000;
    const broker = new LocalConfirmationBroker({
      directory,
      ttlMs: 5_000,
      pollIntervalMs: 50,
      maxPending: 4,
      enabled: true,
      now: () => now,
      createPublicId: () => "LOCAL003",
    });
    await broker.initialize();
    const handle = await broker.request(scope, request());
    now += 6_000;
    expect(await writeLocalApprovalDecision(directory, "LOCAL003", "approve", now)).toBe("expired");
    broker.cancelAll();
    await expect(handle?.decision).resolves.toBe("deny");
  });
});
