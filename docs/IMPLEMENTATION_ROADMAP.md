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

- managed Codex + Responses bridge lifecycle with ephemeral local credentials
- owner pairing from the intended QQ account
- QQ → SQLite → Codex → DeepSeek → QQ foreground smoke test
- persistent managed `CODEX_HOME` and Codex thread evidence after process restart
- safe pre-turn recovery for thread IDs left by the former temporary-home implementation
- reconnect/resume evidence after network restart
- LaunchAgent remains blocked until both acceptance probes pass

### Phase 3C — LaunchAgent service and crash recovery

- correct compiled production entry under `dist/src`
- generated per-user LaunchAgent with no credentials embedded in the plist
- owner-only `.env` and plist permission checks
- atomic single-instance lock with stale-lock recovery
- bounded service-state file for readiness and diagnostics
- rotating stdout/stderr logs managed outside launchd
- graceful signal forwarding and forced-shutdown deadline
- explicit install/start/status/restart/stop/logs/uninstall commands
- opt-in crash-recovery probe that verifies a new ready PID

## Phase 4.0 — configuration federation

### Phase 4.0A — inventory and capability catalog

- inventory explicit `.env`/schema keys without reading secret values;
- freeze hardcoded Codex, DeepSeek, SearXNG, QQ SDK, MCP, and Peekaboo decisions;
- record upstream-managed, passthrough, observed-only, and locked surfaces;
- probe installed versions and QQ SDK declaration types when available;
- emit stable source and runtime fingerprints;
- do not change production behavior.

### Phase 4.0B — configuration federation core

- canonical non-secret `config/floral.toml`;
- typed requested and effective configuration;
- environment override provenance for every inventoried key;
- SecretRef presence metadata without secret values;
- locked-field and cross-component validation;
- separate requested/effective fingerprints;
- private atomic effective-config artifacts;
- no production runtime adoption yet.

### Phase 4.0C — native adapters and deterministic renderers

- typed Codex native model/provider/MCP configuration;
- Codex `config.toml` and non-installed `requirements.toml` preview;
- typed SearXNG container and `settings.yml` configuration;
- redacted QQ SDK constructor/delivery contract;
- unified MCP transport and tool-policy manifest;
- deterministic artifact and bundle fingerprints;
- private atomic native artifact output;
- no production runtime adoption yet.

### Phase 4.0D — drift and runtime diagnostics

- compare requested, effective, rendered, installed, and observed configuration;
- capture a bounded SearXNG effective engine/plugin/category surface and QQ SDK package surface;
- verify reviewed Codex, QQ SDK, and SearXNG runtime compatibility;
- explain per-key provenance and affected native artifacts;
- persist a private redacted diagnostic report;
- define a strict, non-destructive controlled production cutover gate;
- keep production runtime generation unchanged until the gate is intentionally adopted.

### Phase 4.0E1 — Codex unified shadow adoption

- connect the configuration authority to the real managed Codex startup path;
- keep the legacy generator as the production `config.toml`;
- render the unified Codex config with the same runtime bridge endpoint;
- compare shared TOML assignments and allow only reviewed safety additions;
- persist a private redacted shadow report and expose a dedicated check;
- fail open to the legacy generator if shadow diagnostics fail;
- keep the global cutover gate blocked until Phase 4.0E2 explicitly adopts unified output.

### Phase 4.0E2 — Codex unified controlled cutover

- require a current compatible Codex-scoped shadow report before activation;
- install unified `config.toml` with file sync, atomic rename, and private permissions;
- save the generated legacy config as a short-lived rollback copy;
- retry Codex exactly once with the legacy config after unified startup failure;
- persist a tamper-evident, redacted cutover result;
- expose dedicated cutover status and check commands;
- require installed, shadow, runtime, and cutover observations to agree before the global gate becomes ready.

### Phase 4.0E3 — MCP registry runtime adoption

- build one typed canonical registry for active and planned MCP servers;
- render the private MCP manifest and Codex `mcp_servers.*` sections from the same registry;
- reject duplicate IDs, tools, environment keys, parent-environment inheritance, and premature planned-adapter activation;
- verify the active Codex MCP assignment projection against the registry after startup;
- persist a private tamper-evident registry adoption report;
- fold MCP registry status into the global configuration cutover gate;
- retain the legacy Codex generator only for emergency rollback.

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

## Phase 6 — remaining service hardening

- encrypted secret handling beyond owner-only local `.env`
- backup/restore and incident lockout
- long-run resource and log-retention soak tests
- release/upgrade rollback procedure
