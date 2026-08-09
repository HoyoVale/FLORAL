# Phase 5.2 — Authorization and QQ Approval Authority

Phase 5.2 adds a FLORAL-owned authorization boundary in front of approval-bound
agent actions. The language model is not an authorization boundary.

## Invariants

Authorization is evaluated from independent local facts:

```text
resolved gateway role
∩ FLORAL capability mapping
∩ current Codex sandbox ceiling
∩ active MCP server/tool allowlist
∩ approval level
∩ one-shot approval grant (when required)
```

A missing mapping or failed check denies the request.

## Capability policy

Roles remain owner/operator/viewer. Active MCP tools must have an explicit
FLORAL capability mapping before the service can construct the authorization
authority. The current active search tool maps to `web.search` and is automatic.
Planned vision tools map to `screen.capture`; planned GUI control tools remain
disabled until their dedicated adapter phase.

Generic write and externally visible capabilities require chat confirmation.
`system.admin` and `system.restart` require Mac-local confirmation.

Opaque Codex command escalation uses owner chat confirmation. Codex remains
the execution-policy authority for the native command request; FLORAL does not
attempt to infer shell safety independently and only authenticates who may
answer the already-issued approval request.

## QQ one-shot approval flow

When an approval-bound action is eligible for remote confirmation, FLORAL sends
an owner-visible prompt with a random public approval ID:

```text
FLORAL 请求一次性授权
审批编号=XXXXXXXXXXXXXXXX
能力=files.write
请求=<bounded summary>
有效期=60 秒
允许：/approve XXXXXXXXXXXXXXXX
拒绝：/deny XXXXXXXXXXXXXXXX
```

The public ID is not the Codex request ID. The grant is bound to:

- the resolved owner user;
- the persisted FLORAL conversation;
- the single pending request;
- a short TTL;
- the current gateway process lifetime.

Approval is one-shot. Expiry, `/deny`, `/stop`, run completion, gateway stop, or
service restart invalidates the pending grant. A different user or conversation
cannot consume it.

Only the owner may grant remote approvals. This invariant is locked in the
configuration authority.

## Audit and data minimization

Audit records include only bounded metadata such as capability, approval kind,
outcome, and the public approval ID. Raw Codex request IDs, command bodies,
diffs, prompts, tool outputs, credentials, and reasoning are not persisted.

Approval summaries sent to QQ are bounded and redact obvious `api_key=`,
`token=`, `secret=`, and `password=` assignments.

## Codex app-server integration

`item/commandExecution/requestApproval` and
`item/fileChange/requestApproval` are converted into typed FLORAL approval
requests before a response is sent back to Codex. A run-scoped approval handler
returns only `accept` or `decline` to app-server.

`item/permissions/requestApproval` remains fail-closed and returns an empty
permission subset. Granular filesystem/network permission expansion is not
remotely delegable yet. MCP elicitation forms remain declined.

Production Codex still uses the existing Phase 4 safety baseline:

```text
sandbox = read-only
approvalPolicy = never
```

Phase 5.2 therefore installs the authorization authority without silently
opening write access or unsandboxed command execution. A later capability phase
may intentionally activate a narrower Codex approval/sandbox profile after a
controlled compatibility review.

## Configuration

```toml
[runtime.authorization]
enabled = true
approval_ttl_ms = 60000
max_pending_approvals = 8
owner_only_remote_approval = true
```

`enabled` and `owner_only_remote_approval` are locked safety fields.

## Operator checks

```bash
corepack pnpm policy:status
corepack pnpm policy:check
```

Expected production baseline:

```text
policy.authorization.enabled=true
policy.authorization.owner_only_remote=true
policy.sandbox=read-only
policy.codex.command=approval:chat-confirmation
policy.codex.file_change=deny:sandbox-capability-denied
policy.system_admin=deny:sandbox-capability-denied
policy.mcp.search=allow:automatic
policy.failures=none
policy=ok
```

QQ `/status` also includes `approvals_pending=<n>`.
