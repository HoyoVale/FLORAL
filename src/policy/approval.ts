import type { Capability } from "./permissions.js";

export type ApprovalLevel = "automatic" | "chat-confirmation" | "local-confirmation";

const localOnly = new Set<Capability>(["system.admin", "system.restart"]);
const chatConfirmation = new Set<Capability>([
  "files.delete", "software.install", "browser.submit", "message.send"
]);

export function approvalLevelFor(capability: Capability): ApprovalLevel {
  if (localOnly.has(capability)) return "local-confirmation";
  if (chatConfirmation.has(capability)) return "chat-confirmation";
  return "automatic";
}
