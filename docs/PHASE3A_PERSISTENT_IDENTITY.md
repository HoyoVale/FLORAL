# Phase 3A — persistent identity, conversations, commands, and audit

Phase 3A moves gateway identity and Codex thread state out of process memory and into SQLite. It deliberately stops before enabling the real QQ wire contract; the transport adapter remains a separate boundary for Phase 3B. The QQ SDK dependency is pinned exactly to `@tencent-connect/qqbot-nodejs@1.0.4` so Phase 3B validates one immutable API surface.

## Security boundary

- An unknown QQ OpenID cannot reach the agent.
- The first owner must send `/pair <code>` using the locally configured `OWNER_PAIRING_CODE`.
- The pairing code is compared in constant time and is never written to audit records or replies.
- Five failed attempts within ten minutes temporarily block more attempts for fifteen minutes.
- Only one owner may be claimed per transport + bot ID.
- Mock mode may auto-claim its deterministic local identity when `MOCK_TRUST_OWNER=true`.
- Message receipts are deduplicated before authorization or agent execution.
- Inbound text above 32,000 characters is rejected before authorization or model execution.
- Audit payloads contain event metadata and bounded counts, never message or response bodies.

`QQ_MODE=real` requires an owner pairing code of at least 12 characters. Generate a random value locally and keep it only in `.env` or the process environment.

## Persistent schema

The SQLite database defaults to:

```dotenv
DATABASE_PATH=./data/floral.sqlite
```

Schema version 3 contains:

- `users`
- `owner_bindings`
- `external_identities`
- `conversations`
- `message_receipts`
- `audit_events`

The active Codex thread belongs to an internal conversation row keyed by transport, bot ID, and external conversation ID. The external QQ OpenID and conversation ID remain transport identifiers; they are not used as internal primary keys.

SQLite runs with WAL mode, foreign-key enforcement, and a bounded busy timeout. Existing Phase 0 tables are upgraded in place by adding missing columns and indexes.

## Commands

### `/pair <code>`

Claims the first owner for the current bot. Unknown users cannot use any other gateway capability.

### `/status`

Returns bounded operational state:

- transport adapter name
- agent runtime name
- authorized role
- whether a persistent thread exists
- whether a turn is currently running

It does not expose OpenIDs, internal user IDs, conversation IDs, or thread IDs.

### `/new`

Clears the active Codex thread for the current conversation. It refuses while a turn is running.

### `/stop`

Interrupts the active Codex turn. When the turn has not yet returned its thread ID, the stop request is recorded and dispatched immediately after `run.started`.

## Duplicate and concurrent delivery

QQ may redeliver an event. `message_receipts` uses transport + bot ID + message ID as a unique key, so a duplicate cannot produce another model turn or another reply.

Only one agent run may be active per internal conversation. A second normal message receives a busy reply instead of starting an overlapping turn. `/status` and `/stop` remain available while that run is active.

## Audit events

Examples include:

```text
identity.owner_paired
identity.pairing_failed
identity.pairing_rate_limited
authorization.denied
command.status
command.new
command.stop
agent.run_requested
agent.run_completed
agent.run_failed
agent.interrupt_sent
agent.tool.started
agent.tool.completed
```

Prompt text, model output, pairing codes, credentials, tool arguments, and tool result bodies are not stored.

## Validation

Windows and CI:

```bash
corepack pnpm bootstrap:validate
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm storage:probe
```

Mac persistent database diagnostics:

```bash
corepack pnpm storage:doctor
```

`storage:doctor` prints counts and schema version only. It does not print identities or audit payloads.

## Phase boundary

Phase 3A validates persistence and command policy using mock transports and fake runtimes. Phase 3B will validate the exact current `@tencent-connect/qqbot-nodejs` private-message event and reply API on the Mac before `QQ_MODE=real` is accepted as complete.
