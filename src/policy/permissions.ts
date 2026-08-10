import type { Capability, GatewayRole } from "../core/types.js";

export type Role = GatewayRole;

const roleCapabilities: Record<Role, ReadonlySet<Capability>> = {
  viewer: new Set([
    "machine.status.read",
    "screen.capture",
    "files.read",
    "web.search",
    "github.repository.read",
    "browser.inspect",
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
    "github.repository.read",
    "browser.inspect",
  ]),
  owner: new Set([
    "machine.status.read",
    "screen.capture",
    "files.read",
    "files.write",
    "files.delete",
    "shell.execute",
    "software.install",
    "extension.install",
    "extension.update",
    "extension.remove",
    "extension.enable",
    "extension.disable",
    "skill.publish",
    "github.repository.read",
    "github.issue.write",
    "github.pull-request.write",
    "github.actions.run",
    "browser.inspect",
    "application.open",
    "application.control",
    "browser.submit",
    "message.send",
    "web.search",
    "codex.permission.grant",
    "system.restart",
    "system.admin",
  ]),
};

export function roleAllows(role: Role, capability: Capability): boolean {
  return roleCapabilities[role].has(capability);
}
