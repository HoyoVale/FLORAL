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

### Phase 4.0E4 — QQ SDK runtime options adoption

- build one secret-free runtime contract for SDK constructor, session, and delivery options;
- resolve AppID/AppSecret only from environment SecretRefs at transport creation;
- inject reviewed token prefetch, file persistence, account ID, and redacted logger policy;
- use the same unified options builder in production and exclusive QQ probes;
- verify the installed SDK version before unified startup;
- persist a private tamper-evident QQ adoption report;
- retry exactly once with established legacy options after unified startup/report failure;
- fold QQ runtime adoption into the global configuration cutover gate.

### Phase 4.0E5 — SearXNG runtime preparation adoption

- move container preparation and effective `settings.yml` installation behind the unified authority;
- verify the pinned image digest against the reviewed compatibility catalog before startup;
- require checked-in compose/settings projections to match the unified renderer;
- capture the bounded `/config` engine/plugin/category observation as a tamper-evident adoption report;
- retry once through the checked-in infrastructure template after unified preparation/startup failure;
- fold SearXNG runtime adoption into the global configuration cutover gate.

## Phase 5 — agent safety and cost control

### Phase 5.1 — DeepSeek cost guard and runaway protection

- meter every provider attempt before external I/O;
- persist rolling request, token, and estimated-CNY budgets across restarts;
- fingerprint translated provider requests without persisting prompt contents;
- block duplicate loops and excessive unknown-usage failures locally;
- capture DeepSeek cache-hit/cache-miss/reasoning usage;
- expose local CLI and QQ `/status` budget visibility;
- keep provider retry logic unable to bypass the guard.

### Phase 5.2 — authorization and approval authority

- bind Codex approval-bound execution and every active MCP tool to explicit FLORAL capabilities;
- add owner-scoped one-shot QQ `/approve` and `/deny` commands;
- add expiry, requester/conversation/request binding, run cleanup, and restart invalidation;
- require local confirmation for system administration and opaque Codex command escalation;
- keep production Codex read-only/never-approve until a later controlled capability activation.

### Phase 5.3 — controlled capability activation and Mac-local confirmation

- keep the native fail-safe config at read-only/never, but run active app-server turns with cwd-only workspace-write, network disabled, user review, and the pinned 0.146.1 `untrusted` approval wire policy;
- allow only concrete Codex file-change requests to reach the existing owner-scoped QQ one-shot approval flow;
- keep generic `files.write` denied by FLORAL's native read-only authorization ceiling so the execution sandbox cannot widen later actions;
- route opaque command escalation to a private Mac-local one-shot confirmation mailbox, never to QQ `/approve`;
- bind local decisions to the current service session and exact private request fingerprint, with restart cleanup and expiry;
- never return `acceptForSession` or a persistent permission grant.
- install a private Codex custom-model catalog for DeepSeek so the real turn exposes freeform `apply_patch` instead of fallback metadata with no patch tool;
- enforce DeepSeek V4 thinking-mode tool compatibility in the Responses bridge and emit a bounded apply-patch tool-surface diagnostic.


### Phase 5.4 — QQ Conversation UX

- 5.4A: presentation fallback, semantic mobile chunking, user-facing status/help.
- 5.4A-2: SDK-native typing indicator plus one per-conversation outbound sequencer; real-device correction keeps `msgId` only on passive text replies, sends typing with a bare `ReplyTarget`, uses a short keepalive cadence, preserves assistant+tool-call history across the DeepSeek bridge, and rejects pre-tool commentary as a terminal answer.
- 5.4A-2.3: direct QQ SDK typing visibility probe; isolates client/platform rendering from FLORAL runtime when the SDK reports success but mobile QQ shows no indicator.
- 5.4A-2.4: isolated probe confirmed repeated SDK typing success with no mobile rendering; production native typing is therefore disabled and replaced by a configurable single delayed visible activity fallback for long real-QQ runs.
- 5.4B: QQ Inline Keyboard `[允许一次] [拒绝]` implementation and probes are complete, but production exposure is platform-gated while message-template approval is pending; stable `/approve <id>` and `/deny <id>` remain the production path. Native Markdown stays decoupled from authorization.
- Authorization semantics remain owned by the existing policy and approval layers.

### Phase 5F — Feishu primary transport migration

- 5F.0/5F.1: add the Feishu transport identity, pin the official Node SDK, normalize P2P text events, and pass a direct target-Mac long-connection receive/send probe while leaving production unchanged.
- 5F.2: select the primary chat transport explicitly, federate Feishu credentials/options, isolate long-connection ingress in a worker thread, route P2P text through the existing Gateway/SQLite/Codex stack, and keep remote approval on the established text command path. QQ remains a compatibility transport.
- 5F.3A: Feishu JSON 2.0 approval-card isolation probe; validates `card.action.trigger` over the existing long connection before production authorization exposure.
- 5F.3: after the production text chain passes, add Feishu interactive approval cards without moving authorization into the transport.

## Phase 6 — macOS GUI and visual MCP

- MiMo-backed read-only visual analysis;
- Peekaboo MCP health and required-tool checks;
- screenshot and application-control smoke tests;
- per-tool authorization proxy or Codex approval mapping;
- evidence artifacts for each GUI E2E run.

## Phase 7 — Better Auth and web administration

- account/session endpoints
- chat identity linking (Feishu primary, QQ compatibility)
- role administration
- approval and audit dashboard
- passkeys/2FA for owner administration

## Phase 8 — remaining service hardening

- encrypted secret handling beyond owner-only local `.env`
- backup/restore and incident lockout
- long-run resource and log-retention soak tests
- release/upgrade rollback procedure
