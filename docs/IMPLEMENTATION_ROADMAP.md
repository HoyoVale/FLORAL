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

### Phase 2B.2-A — local web search tool

- loopback-only SearXNG Docker development service
- pinned open-source `mcp-searxng@1.0.3` stdio adapter
- expose only `searxng_web_search`; keep URL reading disabled
- bounded MCP tool lifecycle events
- Codex → DeepSeek → MCP → SearXNG multi-turn E2E probe

### Phase 2B.2-B — bridge and search hardening

#### Phase 2B.2-B1 — operational hardening

- bounded bridge concurrency, queueing, timeout, and capacity diagnostics
- persistent Colima + Docker restart lifecycle documentation
- container and application-level SearXNG health diagnostics
- validated SearXNG image pinned by immutable digest

#### Phase 2B.2-B2 — protocol resilience

##### Phase 2B.2-B2.1 — Codex compatibility fixtures

- explicit opt-in capture of sanitized real Codex Responses requests
- structural fingerprints with model, content, credentials, paths, and identifiers removed
- committed namespace, tool-result, reasoning, custom-tool, and unknown-field replay fixtures
- `codex:compat:check` for Windows, CI, and post-upgrade Mac validation

##### Phase 2B.2-B2.2 — pre-stream retry and fault injection

- bounded network/408/429/selected-5xx retry before the first provider stream chunk
- cancellation propagation through queued, active, and shutdown paths
- strict malformed-SSE and missing-`[DONE]` classification
- failure-injection coverage for recovery and no-replay boundaries
- no retry after text, reasoning, or tool stream activity begins

##### Deferred URL reading policy

- keep `web_url_read` disabled
- add SSRF-safe URL reading only after explicit network policy work

## Phase 3 — real QQ + persistent identity

### Phase 3A — persistent gateway state and command policy

- SQLite users, external identities, conversations, message receipts, and audit events
- owner pairing policy with constant-time code comparison and bounded failed attempts
- persistent Codex thread mapping and duplicate-message rejection
- `/new`, `/status`, and `/stop` command core
- one active agent run per conversation and interrupt propagation
- mock-mode and cross-platform tests before enabling the public transport

### Phase 3B — verified QQ private-chat transport

#### Phase 3B.1 — exact SDK contract and bounded C2C adapter

- exact `@tencent-connect/qqbot-nodejs@1.0.4` event and reply contract
- C2C-only inbound mapping; group and channel events fail closed
- persisted WebSocket resume state with ready/resumed/error lifecycle
- bounded passive-reply target cache, text chunking, timeout, and no-duplicate retry policy
- offline SDK contract check and deterministic private passive-reply probe
- delivery-failure audit without rerunning a completed agent turn

#### Phase 3B.2 — real full-chain acceptance

- owner pairing from the intended QQ account
- QQ → SQLite → Codex → DeepSeek → QQ foreground smoke test
- reconnect/resume evidence after process and network restart
- LaunchAgent remains blocked until the foreground chain passes

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
