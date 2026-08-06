# Implementation roadmap

## Phase 0 — environment baseline

- Windows and macOS doctor scripts
- mock QQ and mock Agent loop
- Codex JSON-RPC process/client boundary
- Codex schema generation on the target Mac
- Peekaboo readiness checks and MCP configuration sample
- security and launchd documentation

## Phase 1 — real Codex App Server runtime

- initialize / initialized handshake
- thread/start and thread/resume lifecycle
- turn/start, turn/completed, and turn/interrupt
- streamed assistant deltas with authoritative final items
- fail-closed server-request handling
- typed quota, authentication, network, timeout, process, and protocol failures
- Fake App Server tests that run on Windows and CI
- real Mac protocol probe with usage-limit classification

## Phase 2 — model provider integration

### Phase 2A — DeepSeek provider baseline

- direct DeepSeek Chat Completions client and probe
- `.env` loading with credentials kept outside the repository
- provider health, timeout, error classification, and secret redaction
- fake HTTP provider tests on Windows and CI
- validate `deepseek-v4-flash` before introducing protocol translation

### Phase 2B.1 — Codex Responses bridge baseline

- loopback-only authenticated `/v1/responses` bridge
- Responses messages → DeepSeek Chat Completions translation
- streamed text and function/custom tool-call translation
- direct bridge probe and real Codex App Server end-to-end probe
- fail closed on unsupported Responses item and tool types

### Phase 2B.2 — bridge hardening

- captured Codex request compatibility fixtures
- namespace/MCP tool normalization where a verified mapping exists
- bounded retries, concurrency and backpressure
- persistent service lifecycle and diagnostics
- multi-turn tool execution E2E

## Phase 3 — real QQ + persistent identity

- official QQ SDK private chat
- owner pairing by QQ OpenID
- SQLite conversation/thread mapping
- audit events
- `/new`, `/status`, and `/stop` commands

## Phase 4 — macOS GUI

- Peekaboo MCP health and required-tool checks
- screenshot and application-control smoke tests
- per-tool authorization proxy or Codex approval mapping
- evidence artifacts for each GUI E2E run

## Phase 5 — Better Auth and web administration

- account/session endpoints
- QQ identity linking
- role administration
- approval and audit dashboard
- passkeys/2FA for owner administration

## Phase 6 — service hardening

- LaunchAgent install/uninstall/diagnostics
- crash recovery and backoff
- bounded queues and rate limits
- encrypted secret handling
- backup/restore and incident lockout
