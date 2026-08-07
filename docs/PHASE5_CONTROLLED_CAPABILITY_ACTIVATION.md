# Phase 5.3 — Controlled Capability Activation and Local Confirmation

Phase 5.3 activates the approval path built in Phase 5.2 without turning FLORAL
into an unrestricted remote shell. Phase 5.3A corrects the first activation
attempt: **approval and sandbox are separate controls**, and a read-only active
turn can reject a write before app-server ever emits a file-change approval.
The checked-in native Codex config remains the conservative fail-safe, while the
active app-server turn receives a separately bounded workspace-write policy.

## Runtime policy

The checked-in Codex native configuration remains the conservative fail-safe
configuration used by the configuration-federation/cutover chain. At runtime,
FLORAL explicitly starts app-server threads/turns with the following logical
policy:

```text
FLORAL approval policy = untrusted
turn sandbox            = workspace-write
approvals reviewer      = user
writable root           = exact request cwd only
network access          = false
```

For the pinned Codex app-server 0.146.1 protocol this is translated on the wire
to `approvalPolicy = unlessTrusted`, `sandbox = workspaceWrite` for thread
start/resume, and a `sandboxPolicy.type = workspaceWrite` object for turn start.
The native generated `config.toml` stays `approval_policy = never` and
`sandbox_mode = read-only` as a fail-safe if FLORAL fails to supply its runtime
overrides. `danger-full-access` is never activated.

## Concrete file-change flow

A `item/fileChange/requestApproval` request is translated to the typed
`files.write` capability. Only this concrete source can enter the existing QQ
one-shot approval flow while FLORAL keeps the policy authority stricter than
the execution sandbox:

```text
Codex concrete file-change request
  -> FLORAL AuthorizationAuthority
  -> owner + exact conversation + exact request
  -> QQ /approve <id> or /deny <id>
  -> accept or decline for this request only
```

A generic FLORAL `files.write` request is still denied by the FLORAL
authorization ceiling because the authority continues to evaluate against the
native read-only baseline. Only a concrete `codex-file-change` request receives
the scoped exception that can reach QQ. This prevents one approved edit from
becoming a reusable write capability. FLORAL never maps the decision to
`acceptForSession`.

## Opaque command escalation

A Codex command approval remains `local-confirmation`, not `chat-confirmation`.
The gateway publishes only a bounded, redacted notice to QQ and creates a
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
