# Phase 10 — Native Goals and bounded GitHub writes

## Scope

Phase 10 connects two control surfaces without creating replacement subsystems:

- Codex app-server remains authoritative for durable thread Goals through
  `thread/goal/get`, `thread/goal/set`, and `thread/goal/clear`.
- The official GitHub MCP remains the executor for repository metadata, issue,
  pull-request/review, and Actions operations. FLORAL owns identity, capability
  mapping, approval scope, and audit presentation.

GitHub authentication is intentionally deferred. This phase completes the
configuration, authorization, approval, and offline protocol tests without
requiring or storing a Personal Access Token.

## Native Goal contract

`AgentGoalRuntime` mirrors the app-server response instead of keeping a FLORAL
Goal ledger. The supported native statuses are `active`, `paused`, `blocked`,
`usageLimited`, `budgetLimited`, and `complete`. Objective length is bounded to
4000 characters and token budgets must be positive integers or `null`.

The owner-facing commands are:

- `/goal` or `/goal status`
- `/goal set [--tokens <positive-integer|off>] <objective>`
- `/goal active`, `/goal pause`, `/goal blocked`, `/goal complete`
- `/goal clear`

Goal mutation through chat commands is owner-only and is rejected while a turn
or queued task is active. The Agent receives the `floral_goal` namespace for
native status/create/update/clear calls. Its developer contract permits
mutation only for an explicit user Goal request; ordinary tasks must not be
silently converted into durable Goals.

## GitHub write contract

`github-readonly` remains server-enforced read-only. `github-owner` uses the
official remote endpoint with the `issues`, `pull_requests`, `actions`, and
`repos` toolsets. FLORAL maps only known tool names and fails closed for unknown
future tools.

Allowed writes are bounded to:

- issue creation/update/comment/sub-issue operations;
- pull-request creation, metadata update, comments, reviews, and review
  submission;
- workflow trigger, cancel, rerun, and run-log deletion.

Repository content/ref publication remains excluded: file create/update/push/
delete, merge, branch creation/update, repository creation, and fork tools are
not exposed. This preserves the repository rule that commit and push are
performed by the project owner.

Every GitHub write approval is:

- owner-only;
- checked against the exact server/tool capability allowlist;
- bound to the server id, tool name, bounded target, and SHA-256 digest of the
  canonical tool arguments;
- one-shot (`/approve-session` is rejected for MCP writes);
- rendered with its target and parameter digest for review and audit.

## Verification state

Windows verification covers native Goal RPC set/get/update/clear, Agent dynamic
Goal creation, owner chat commands, GitHub approval correlation, exact-scope
authorization, one-shot approval behavior, registry exclusions, type checking,
and the full test/build gates.

Live GitHub reads/writes are not an acceptance requirement until the owner adds
supported authentication. macOS and Feishu acceptance should therefore verify
Goal persistence and GitHub write planning/approval denial without a token; no
external GitHub mutation should be attempted in this phase.
