export type Capability =
  | "machine.status.read"
  | "screen.capture"
  | "files.read"
  | "files.write"
  | "files.delete"
  | "shell.execute"
  | "software.install"
  | "application.open"
  | "application.control"
  | "browser.submit"
  | "message.send"
  | "system.restart"
  | "system.admin";

export type Role = "owner" | "operator" | "viewer";

const roleCapabilities: Record<Role, ReadonlySet<Capability>> = {
  viewer: new Set(["machine.status.read", "screen.capture", "files.read"]),
  operator: new Set([
    "machine.status.read", "screen.capture", "files.read", "files.write",
    "shell.execute", "application.open", "application.control"
  ]),
  owner: new Set([
    "machine.status.read", "screen.capture", "files.read", "files.write",
    "files.delete", "shell.execute", "software.install", "application.open",
    "application.control", "browser.submit", "message.send", "system.restart",
    "system.admin"
  ])
};

export function roleAllows(role: Role, capability: Capability): boolean {
  return roleCapabilities[role].has(capability);
}
