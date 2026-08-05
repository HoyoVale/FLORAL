# Implementation roadmap

## Phase 0 — environment baseline

- Windows and macOS doctor scripts
- mock QQ and mock Agent loop
- Codex JSON-RPC process/client boundary
- Peekaboo readiness checks and MCP configuration sample
- remote SSH test script
- security and launchd documentation

## Phase 1 — real QQ + persistent identity

- official QQ SDK private chat
- owner pairing by QQ OpenID
- SQLite conversation/thread mapping
- audit events
- `/new`, `/status`, `/stop` commands

## Phase 2 — real Codex execution

- stable thread/start, thread/resume, turn/start, turn/interrupt
- streamed assistant/tool events
- server-request approval handling
- DeepSeek provider validation
- protocol version/schema compatibility tests

## Phase 3 — macOS GUI

- Peekaboo MCP health and required-tool checks
- screenshot and application-control smoke tests
- per-tool authorization proxy or Codex approval mapping
- evidence artifacts for each GUI E2E run

## Phase 4 — Better Auth and web administration

- account/session endpoints
- QQ identity linking
- role administration
- approval and audit dashboard
- passkeys/2FA for owner administration

## Phase 5 — service hardening

- LaunchAgent install/uninstall/diagnostics
- crash recovery and backoff
- bounded queues and rate limits
- encrypted secret handling
- backup/restore and incident lockout
