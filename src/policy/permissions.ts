import type { Capability, GatewayRole } from "../core/types.js";

export type Role = GatewayRole;

const roleCapabilities: Record<Role, ReadonlySet<Capability>> = {
  viewer: new Set([
    "machine.status.read",
    "screen.capture",
    "files.read",
    "web.search",
  ]),
  operator: new Set([
    "machine.status.read",
    "screen.capture",
    "files.read",
    "files.write",
    "shell.execute",
    "application.open",
    "application.control",
    "web.search",
  ]),
  owner: new Set([
    "machine.status.read",
    "screen.capture",
    "files.read",
    "files.write",
    "files.delete",
    "shell.execute",
    "software.install",
    "application.open",
    "application.control",
    "browser.submit",
    "message.send",
    "web.search",
    "system.restart",
    "system.admin",
  ]),
};

export function roleAllows(role: Role, capability: Capability): boolean {
  return roleCapabilities[role].has(capability);
}
