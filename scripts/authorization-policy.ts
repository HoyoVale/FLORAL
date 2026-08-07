import { resolveConfigurationAuthority } from "../src/config/federation/config-authority.js";
import { loadProjectEnv } from "../src/config/load-project-env.js";
import { buildMcpRuntimeRegistry } from "../src/config/mcp/mcp-runtime-registry.js";
import { AuthorizationAuthority } from "../src/policy/authorization-authority.js";

loadProjectEnv();
const repositoryRoot = process.cwd();
const config = await resolveConfigurationAuthority({
  repositoryRoot,
  environment: process.env,
});
const authorization = new AuthorizationAuthority({
  enabled: config.effective.runtime.authorization.enabled,
  sandboxMode: config.effective.codex.sandbox.mode,
  allowRemoteFileChangeApproval: config.effective.runtime.authorization.allow_remote_file_change_approval,
  mcpRegistry: buildMcpRuntimeRegistry(config.effective),
});

const command = authorization.evaluate({
  role: "owner",
  capability: "shell.execute",
  source: "codex-command",
});
const fileChange = authorization.evaluate({
  role: "owner",
  capability: "files.write",
  source: "codex-file-change",
});
const systemAdmin = authorization.evaluate({
  role: "owner",
  capability: "system.admin",
  source: "floral",
});
const search = authorization.evaluate({
  role: "owner",
  capability: "web.search",
  source: "mcp-tool",
  mcpServerId: config.effective.mcp.search.id,
  mcpToolName: "searxng_web_search",
});

const lines = [
  `policy.authorization.enabled=${String(config.effective.runtime.authorization.enabled)}`,
  `policy.authorization.approval_ttl_ms=${String(config.effective.runtime.authorization.approval_ttl_ms)}`,
  `policy.authorization.max_pending=${String(config.effective.runtime.authorization.max_pending_approvals)}`,
  `policy.authorization.owner_only_remote=${String(config.effective.runtime.authorization.owner_only_remote_approval)}`,
  `policy.authorization.codex_turn_approval_policy=${config.effective.runtime.authorization.codex_turn_approval_policy}`,
  `policy.authorization.remote_file_change=${String(config.effective.runtime.authorization.allow_remote_file_change_approval)}`,
  `policy.authorization.local_confirmation=${String(config.effective.runtime.authorization.local_confirmation_enabled)}`,
  `policy.authorization.local_approval_ttl_ms=${String(config.effective.runtime.authorization.local_approval_ttl_ms)}`,
  `policy.authorization.local_approval_poll_ms=${String(config.effective.runtime.authorization.local_approval_poll_ms)}`,
  `policy.sandbox=${config.effective.codex.sandbox.mode}`,
  `policy.codex.command=${renderDecision(command)}`,
  `policy.codex.file_change=${renderDecision(fileChange)}`,
  `policy.system_admin=${renderDecision(systemAdmin)}`,
  `policy.mcp.search=${renderDecision(search)}`,
];

const check = process.argv.slice(2).includes("--check");
if (check) {
  const failures: string[] = [];
  if (!config.effective.runtime.authorization.enabled) failures.push("authorization-disabled");
  if (!config.effective.runtime.authorization.owner_only_remote_approval) failures.push("remote-approval-not-owner-only");
  if (command.status !== "approval-required" || command.approvalLevel !== "local-confirmation") {
    failures.push("codex-command-not-local-only");
  }
  if (fileChange.status !== "approval-required" || fileChange.approvalLevel !== "chat-confirmation") {
    failures.push("controlled-file-change-not-chat-confirmation");
  }
  if (config.effective.runtime.authorization.codex_turn_approval_policy !== "on-request") {
    failures.push("codex-turn-approval-policy-not-on-request");
  }
  if (!config.effective.runtime.authorization.local_confirmation_enabled) {
    failures.push("local-confirmation-disabled");
  }
  if (systemAdmin.status !== "deny" || systemAdmin.approvalLevel !== "local-confirmation") {
    failures.push("system-admin-not-local-confirmation");
  }
  if (search.status !== "allow") failures.push("search-tool-not-allowed");
  lines.push(`policy.failures=${failures.length === 0 ? "none" : failures.join(",")}`);
  lines.push(`policy=${failures.length === 0 ? "ok" : "blocked"}`);
  process.stdout.write(`${lines.join("\n")}\n`);
  if (failures.length > 0) process.exitCode = 2;
} else {
  lines.push("policy=ok");
  process.stdout.write(`${lines.join("\n")}\n`);
}

function renderDecision(
  decision: ReturnType<AuthorizationAuthority["evaluate"]>,
): string {
  if (decision.status === "allow") return "allow:automatic";
  if (decision.status === "approval-required") return `approval:${decision.approvalLevel}`;
  return `deny:${decision.reason}`;
}
