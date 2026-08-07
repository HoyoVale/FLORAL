# Phase 5.3 — Controlled Capability Activation and Local Confirmation

Phase 5.3 activates the approval path built in Phase 5.2 without turning FLORAL
into an unrestricted remote shell. Phase 5.3A corrects the first activation
attempt: **approval and sandbox are separate controls**, and a read-only active
turn can reject a write before app-server ever emits a file-change approval.
The checked-in native Codex config remains the conservative fail-safe, while the
active app-server turn receives a separately bounded workspace-write policy.

## Runtime policy

The checked-in Codex native configuration remains the conservative fail-safe
configuration used by the configuration-federation/cutover chain. Phase 5.3F
keeps `thread/start` and `thread/resume` capability-neutral and applies the
reviewed execution policy on every `turn/start`. This avoids app-server's
thread-bootstrap project-trust/config mutation path while keeping the actual
side-effecting turn bounded by FLORAL policy:

```text
FLORAL approval policy = untrusted
turn sandbox            = workspace-write
approvals reviewer      = user
writable root           = exact request cwd only
network access          = false
```

For the pinned Codex app-server 0.146.1 protocol FLORAL sends
`approvalPolicy = untrusted` and `sandboxPolicy.type = workspaceWrite` on
`turn/start`. Thread bootstrap sends only the resolved absolute `cwd` plus the
selected model; it does not carry approval, reviewer, or sandbox overrides.
Phase 5.3A incorrectly followed a stale README example for the approval enum and
sent the internal variant-style `unlessTrusted`; Phase 5.3D corrected that wire
contract, and Phase 5.3F narrows policy overrides to the turn where side effects
can actually occur. The native generated `config.toml` stays
`approval_policy = never` and `sandbox_mode = read-only` as a fail-safe if
FLORAL fails to supply its runtime overrides. `danger-full-access` is never
activated.

## Concrete file-change flow

A `item/fileChange/requestApproval` request is translated to the typed
`files.write` capability. Only this concrete source can enter the existing remote
one-shot approval flow while FLORAL keeps the policy authority stricter than
the execution sandbox:

```text
Codex concrete file-change request
  -> FLORAL AuthorizationAuthority
  -> owner + exact conversation + exact request
  -> remote /approve <id> or /deny <id>
  -> accept or decline for this request only
```

A generic FLORAL `files.write` request is still denied by the FLORAL
authorization ceiling because the authority continues to evaluate against the
native read-only baseline. Only a concrete `codex-file-change` request receives
the scoped exception that can reach the remote chat approval flow. This prevents one approved edit from
becoming a reusable write capability. FLORAL never maps the decision to
`acceptForSession`.

## Opaque command escalation

A Codex command approval remains `local-confirmation`, not `chat-confirmation`.
The gateway publishes only a bounded, redacted notice to the remote chat and creates a
private local approval record. The user must resolve it on the Mac:

```bash
corepack pnpm approval:local:list
corepack pnpm approval:local:approve -- <id>
corepack pnpm approval:local:deny -- <id>
```

QQ `/approve` cannot resolve a Mac-local request. The QQ notice intentionally
omits the command body; `approval:local:list` is the only operator-facing place
that displays the bounded, redacted local request summary.

## Local mailbox security

The mailbox lives under the FLORAL LaunchAgent runtime directory on macOS. A
pending record includes only bounded metadata: public ID, service-session ID,
TTL, capability/kind/source, redacted summary, conversation hash, and an exact
request fingerprint. Raw Codex request IDs are not persisted.

On POSIX, the directory is forced to mode 0700 and files to 0600. Writes use a
private temporary file, `fsync`, and atomic rename. A decision is accepted only
when public ID, service-session ID, and request fingerprint all match. Service
initialization removes old pending/decision records so restart invalidates all
prior local approvals.

The local command summary strips common `api_key`, `token`, `secret`,
`password`, and Bearer credential forms before it is written or shown.

## Still intentionally denied

Phase 5.3 does **not** activate:

- session-scoped approvals;
- persistent command prefix rules;
- granular `item/permissions/requestApproval` grants;
- unreviewed or session-wide write grants beyond the exact turn cwd;
- `danger-full-access`;
- unrestricted sudo or Keychain access;
- remote approval for opaque shell commands or system administration.

## Configuration

```toml
[runtime.authorization]
enabled = true
approval_ttl_ms = 60000
max_pending_approvals = 8
owner_only_remote_approval = true
codex_turn_approval_policy = "untrusted"
codex_turn_sandbox_mode = "workspace-write"
codex_approvals_reviewer = "user"
allow_remote_file_change_approval = true
local_confirmation_enabled = true
local_approval_ttl_ms = 300000
local_approval_poll_ms = 250
```

`local_confirmation_enabled` remains a locked safety field. The existing
`enabled` and `owner_only_remote_approval` safety locks remain in force.

## Operator checks

```bash
corepack pnpm policy:status
corepack pnpm policy:check
corepack pnpm approval:local:list
```

The expected policy surface is:

```text
policy.native_sandbox=read-only
policy.turn_sandbox=workspace-write
policy.authorization.codex_turn_approval_policy=untrusted
policy.authorization.codex_approvals_reviewer=user
policy.codex.file_change=approval:chat-confirmation
policy.codex.command=approval:local-confirmation
policy.system_admin=deny:sandbox-capability-denied
policy.mcp.search=allow:automatic
policy.failures=none
```

The production Mac acceptance test should additionally prove:

1. ordinary chat/search still works without approval prompts;
2. a concrete file edit creates one QQ approval, and `/approve` permits only
   that request;
3. a second edit creates a new approval rather than reusing the first;
4. a command escalation cannot be approved by QQ and creates a Mac-local ID;
5. local approval is consumed once and disappears after resolution/restart;
6. Cost Guard remains idle when no user-triggered run is active.

## Phase 5.3E custom-model tool metadata

The production provider model `deepseek-v4-flash` is a custom model slug from
Codex's perspective. Pinned Codex 0.146.1 fallback metadata sets
`apply_patch_tool_type` to `None`, so a turn can have correct workspace-write and
approval settings while never receiving an `apply_patch` tool. Unit tests that
manually inject `item/fileChange/requestApproval` do not prove the real model
was given that tool.

FLORAL therefore renders a private `model-catalog.json` for the active custom
model and points managed `config.toml` at it with `model_catalog_json`. The
catalog enables only the pinned freeform apply-patch surface, keeps Responses
Lite and multi-agent metadata disabled for the third-party provider, disables
parallel tool calls for conservative side-effect ordering, and records the
official 1M DeepSeek V4 context window. The runtime catalog is mode 0600 and is
removed with the ephemeral managed Codex config on clean shutdown.

The Responses bridge also applies the current DeepSeek V4 thinking-mode tool
compatibility requirements: normal production requests omit `tool_choice`,
reasoning content is replayed for tool-call history, and assistant tool-call
history carries an empty string rather than a null content field. The bridge
emits only the bounded capability diagnostic:

```text
bridge.tool_surface.apply_patch=custom
```

A value of `missing` means the real Codex turn did not expose apply_patch and
Phase 5.3 acceptance must stop before debugging the QQ approval broker.

Phase 5.3F also preserves a bounded, redacted JSON-RPC error message in the
service diagnostic line. Codex app-server currently reuses error code `-32600`
for multiple failures, so `method` plus the redacted `reason` is required before
deciding whether a failure is stale-thread recovery, configuration loading, or
request-shape incompatibility. Secret-like assignments, query parameters, and
Bearer tokens are redacted before logging.
