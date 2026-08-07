import { homedir } from "node:os";
import {
  listLocalApprovalRecords,
  writeLocalApprovalDecision,
} from "../src/policy/local-confirmation-broker.js";
import { resolveLocalConfirmationDirectory } from "../src/policy/local-confirmation-paths.js";

const args = process.argv.slice(2).filter((value) => value !== "--");
const action = args[0] ?? "list";
const publicId = args[1];
const directory = resolveLocalConfirmationDirectory(homedir());

if (action === "list") {
  const records = await listLocalApprovalRecords(directory);
  console.log(`local.approvals.directory=${directory}`);
  console.log(`local.approvals.pending=${String(records.length)}`);
  for (const record of records) {
    const expiresIn = Math.max(0, Math.ceil((Date.parse(record.expiresAt) - Date.now()) / 1_000));
    console.log(`local.approval=${record.publicId}:${record.capability}:expires_in_sec=${String(expiresIn)}`);
    console.log(`local.approval.${record.publicId}.request=${record.summary}`);
  }
  console.log("local.approvals=ok");
} else if (action === "approve" || action === "deny") {
  if (!publicId) {
    throw new Error(`Usage: local-approval.ts ${action} <approval-id>`);
  }
  const result = await writeLocalApprovalDecision(
    directory,
    publicId,
    action === "approve" ? "approve" : "deny",
  );
  console.log(`local.approval.id=${publicId.trim().toUpperCase()}`);
  console.log(`local.approval.action=${action}`);
  console.log(`local.approval.result=${result}`);
  if (result !== "written") process.exitCode = 2;
} else {
  throw new Error(`Unknown local approval action: ${action}`);
}
