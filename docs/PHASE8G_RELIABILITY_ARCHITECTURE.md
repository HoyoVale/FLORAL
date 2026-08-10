# Phase 8G — Reliability Architecture and Acceptance Contract

Status: implementation gate for Windows validation, Mac validation, and Feishu owner acceptance.

## Frozen properties

- At-least-once inbound receipt with SQLite message-id deduplication; ordinary Agent messages acknowledge their receipt only after attachment spooling and durable queue commit.
- Durable execution acceptance through `durable_transactions` and `durable_run_queue`.
- Queued attachments must have bounded private local paths before the queue acknowledges them.
- Long turns renew an execution lease; expired leases are recovered after restart with bounded attempts.
- Durable final text delivery through `durable_outbox`.
- Feishu retries use a stable per-message/per-chunk UUID derived from the outbox idempotency key.
- A transport without an idempotent send contract never receives an automatic replay after an ambiguous failure.
- Every startup recovery is itself a journalled maintenance transaction.
- Maintenance, extension, and governed Context domain ledgers retain their specialized receipts and mirror lifecycle state into the unified SQLite durable journal; worker-completed maintenance is reconciled during startup.
- Owner `auto`/`full` conversation mode persists in SQLite; a lowered machine ceiling prevents a stored `full` value from becoming effective.
- Project Context writes remain proposal- and authorization-gated; verification records freshness and reconciliation marks missing evidence stale.
- Context compaction reconciles receipts immediately, and the approval-gated `refresh_agents` action replaces only FLORAL's managed `AGENTS.md` block while preserving human-authored content.
- Codex Native Memory is recall assistance and cannot outrank repository truth, owner-confirmed decisions, the project context ledger, or current System Awareness evidence.

## Control-plane boundary

`github-readonly` remains server-enforced read-only. `github-owner` is owner-only and exposes the official remote GitHub MCP server with bounded issue, pull-request, review, Actions, and repository metadata operations. FLORAL excludes remote file commit, push, delete, merge, repository creation/fork, branch creation, and PR-branch ref update tools because this repository requires the project owner to perform commit/push/ref publication.

The owner profile uses the official remote endpoint and GitHub's documented toolset/exclusion headers. Token values remain outside generated configuration and diagnostics.

## Required journal versus telemetry

| Class | Examples | Failure rule |
|---|---|---|
| Required journal | run accepted, lease, result delivery, ACK, recovery | Operation does not advance without persistence |
| Best-effort telemetry | progress audit, presentation hint, diagnostic observation | Operation may continue; no authority is derived from the dropped event |

## Recovery matrix

| Injected fault | Expected behavior | Duplicate boundary |
|---|---|---|
| Duplicate inbound message | Receipt rejects the duplicate | transport + bot + message id |
| FLORAL crash with a not-yet-started queued run | Accepted/waiting work remains queued and resumes | durable run idempotency key |
| FLORAL crash during an executing run | Quarantine the ambiguous turn and durably ask the owner to confirm/retry | no whole-turn blind replay after possible mutation |
| FLORAL crash with queued attachment | Local materialized path remains in run record | enqueue rejects remote-only refs |
| Queued attachment disappears or changes | Mark the run handled without starting Codex and ask the owner to resend | path, regular-file type, and byte length |
| Feishu send timeout | Retry with exponential bounded delay | stable Feishu UUID |
| Send succeeds, ACK write is interrupted | Same UUID is replayed after lease recovery | Feishu server deduplication |
| Non-idempotent transport timeout | Terminal ambiguous failure; no blind replay | manual owner intervention |
| Agent/Codex process exits | Run reports a bounded failure; unhandled crash is lease-recoverable | no whole-turn blind replay after handled failure |
| DeepSeek 429/5xx before stream | Existing bridge retry contract applies | provider request boundary |
| Provider failure after streamed/tool output | No whole-turn replay | mutation may already exist |
| SQLite busy | Five-second busy timeout, then fail without state advance | SQLite transaction |
| SQLite unavailable/corrupt | Startup does not enter ready | required store gate |
| Disk full during enqueue | User task is not acknowledged as durable | required journal gate |
| MCP startup/auth failure | Degrade and report exact server/auth state | no shell bypass |
| Extension apply succeeds, reload fails | Existing extension transaction stays pending verification | extension transaction id |
| Maintenance restart interrupted | A handoff/running receipt older than the worker verification window fails during reconciliation and releases the control plane | maintenance transaction id |
| Context body/ledger drift | Verify/reconcile marks receipt stale | content hash marker |

## Operator UX

Normal `/status` stays compact and includes run queue depth, reliable delivery pending/failed counts, and last startup recovery. `/status --debug` preserves deterministic key/value evidence, including queue, delivery, and recovery fields. `/diagnose` returns a bounded owner-readable summary and never performs a repair; `/diagnose --debug` exposes the complete evidence and read-only check plan.

## Decomposition boundary

- `GatewayService`: ingress identity, commands, product orchestration.
- `DurableRunCoordinator`: queue leases, renewal, recovery-safe execution.
- `DeliveryOutboxCoordinator`: durable send, ACK, retry policy.
- `StartupRecoveryCoordinator`: cross-kind expired lease recovery and recovery receipt.
- `CodexAppServerRuntime`: protocol orchestration; individual Context, Extension, Artifact, System, RPC, workspace, and presentation policies remain in dedicated modules.

Structure budgets prevent these orchestration files from silently regrowing while later behavioral extraction continues.

## Validation gates

1. Windows: typecheck, full Vitest, build, reliability fault suite, runtime-data Git-boundary check.
2. Project owner: review the diff, remove no local runtime data, commit and push.
3. Mac: `git pull --ff-only`, typecheck, full Vitest, build, service restart/status, clean worktree.
4. Feishu: status, FIFO two-message run, restart recovery observation, final reply, file/image queue, stop/cancel, owner-only GitHub catalog, Context status/verify.
5. Any failed item becomes one isolated repair and is rerun on Windows and Mac before acceptance closes.
