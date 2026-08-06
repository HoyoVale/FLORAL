import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteGatewayStore } from "../src/storage/sqlite.js";

const directory = await mkdtemp(join(tmpdir(), "floral-storage-probe-"));
const databasePath = join(directory, "gateway.sqlite");
const identity = {
  transport: "mock" as const,
  botId: "probe-bot",
  externalUserId: "probe-owner",
  conversationId: "probe-conversation",
  displayName: "Probe Owner",
};

try {
  const first = await SqliteGatewayStore.open(databasePath);
  const acceptedFirst = await first.acceptMessage(
    identity,
    "probe-message",
    new Date(),
  );
  const acceptedDuplicate = await first.acceptMessage(
    identity,
    "probe-message",
    new Date(),
  );
  const owner = await first.claimOwner(identity);
  await first.setActiveThread(owner.conversationId, "probe-thread");
  await first.appendAudit({
    userId: owner.userId,
    conversationId: owner.conversationId,
    eventType: "probe.completed",
  });
  await first.close();

  const reopened = await SqliteGatewayStore.open(databasePath);
  const resolved = await reopened.resolveIdentity(identity);
  const thread = resolved
    ? await reopened.getActiveThread(resolved.conversationId)
    : undefined;
  const diagnostics = reopened.diagnostics();

  if (
    !acceptedFirst
    || acceptedDuplicate
    || !resolved
    || resolved.role !== "owner"
    || thread !== "probe-thread"
    || diagnostics.schemaVersion !== 3
  ) {
    throw new Error("Persistent gateway storage probe failed");
  }

  console.log("storage.probe.message_dedup=ok");
  console.log("storage.probe.owner_pairing=ok");
  console.log("storage.probe.thread_persistence=ok");
  console.log("storage.probe.audit=ok");
  console.log("storage.probe.result=ok");
  await reopened.close();
} finally {
  await rm(directory, { recursive: true, force: true });
}
