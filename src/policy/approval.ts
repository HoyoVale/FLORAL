import type { Capability } from "../core/types.js";

export type ApprovalLevel = "automatic" | "chat-confirmation" | "local-confirmation";

const localOnly = new Set<Capability>(["system.admin", "system.restart"]);
const chatConfirmation = new Set<Capability>([
  "files.write",
  "files.delete",
  "software.install",
  "extension.install",
  "extension.update",
  "extension.remove",
  "skill.publish",
  "github.issue.write",
  "github.pull-request.write",
  "github.actions.run",
  "application.control",
  "browser.submit",
  "message.send",
  "codex.permission.grant",
]);

export function approvalLevelFor(capability: Capability): ApprovalLevel {
  if (localOnly.has(capability)) return "local-confirmation";
  if (chatConfirmation.has(capability)) return "chat-confirmation";
  return "automatic";
}
