# FLORAL Phase 8F Comprehensive Code Audit — Robustness & User Experience

Audit baseline: `a6befa1` (`Phase 8E + 8D fixup`)

Scope: current FLORAL repository after the Phase 8A–8E architecture was completed. The audit focuses on task robustness, recoverability, owner experience, authorization friction, and failure modes rather than adding new product capabilities.

## Executive assessment

FLORAL's strongest property is now its explicit control-plane separation: configuration, authorization, System Awareness, diagnostics, maintenance, extension lifecycle, project isolation, and artifact egress each have independent authorities. Phase 8 has substantially reduced the risk of the Agent treating observation, installation, runtime readiness, and authorization as the same concept.

The largest remaining engineering risk is no longer missing capability. It is **orchestration complexity**: `src/service/gateway.ts` is above 3k lines and `src/agent/codex-app-server.ts` above 4k lines. Both contain many independently correct mechanisms whose interactions are increasingly difficult to reason about in one file. This is a maintainability/reliability risk, not an immediate release blocker.

The current patch addresses the highest-value low-risk issues discovered during audit: config recovery, centralized trusted-owner approval, message backpressure, preflight concurrency, cancellation, actionable failure replies, stale tests/docs, and extension policy wording.

## Subsystem review

### 1. Chat ingress and transports — GOOD, with delivery durability backlog

Observed strengths:

- SQLite-backed message receipt deduplication protects against duplicate inbound delivery across reconnects.
- Feishu and QQ serialize outbound operations per conversation, protecting ordering.
- Feishu inbound files are bounded by count/size/time and materialized into private locations.
- Interactive approval routes bind approval IDs to the expected external user/conversation and expire.
- Typing/activity failures are best-effort and do not take down the run.

Remaining risks:

- Final text/media delivery is not backed by a durable outbound outbox. A process/network failure after Agent completion but before successful delivery can lose the user-visible result.
- Automatic retry at the transport layer is non-trivial because an ambiguous network failure can mean the upstream accepted a send and only the response was lost; naive retry can duplicate messages.

Recommendation (P1): add a durable outbound delivery ledger with transport-specific idempotency keys where supported, delivery attempt state, bounded retry, and manual replay visibility. Do not implement blind retry without duplicate-safety semantics.

### 2. Gateway orchestration — FUNCTIONALLY STRONG, complexity is the main risk

Observed strengths:

- durable identity/message dedup;
- project-aware thread persistence;
- commands bypass long Agent turns so `/status`, approvals, and `/stop` remain responsive;
- artifacts, approvals, maintenance handoff, and activity indicators are bounded and separately audited;
- conversation-scoped execution policy exists and is visible through System Awareness.

Issues fixed in Phase 8F:

- normal follow-up messages were previously dropped while a run was active;
- asynchronous preflight allowed a narrow overlapping-turn race before `#activeRuns` was set;
- `/stop` could not cancel that preflight window;
- project/mode/thread state changes could race queued work;
- generic failure replies forced unnecessary Mac-local log inspection.

Remaining risks:

- queued attachment messages are not yet durably spooled at enqueue time. If a transport attachment URL/resource expires while waiting, materialization may fail later.
- queued messages use the conversation's state at execution time; Phase 8F blocks explicit state-changing commands while work is pending, which mitigates the main project/mode drift path, but durable queue semantics would be cleaner.
- in-memory control mode returns to `ask` after service restart. For trusted-owner deployments this causes repeated `/mode full` friction, especially after governed self-restarts.

Recommendations:

- P1: spool queued attachments immediately into a private bounded queue store and bind each queued item to its project/runtime namespace.
- P1: add an owner-controlled persistent/default conversation execution mode, still capped by `FLORAL_REMOTE_MODE_CEILING`.
- P1: split `gateway.ts` into command routing, run scheduler, approvals, artifact delivery, and system-control adapters without changing behavior.

### 3. Authorization and approvals — STRONG after Phase 8F centralization

Observed strengths:

- role capability checks are host-owned;
- MCP tools require allowlist/capability mapping;
- curated External MCP/Skill installation has narrow sandbox exceptions rather than generic shell elevation;
- maintenance has a separate host source and separate autonomy controller;
- local-only capabilities remain distinct from remote chat confirmation;
- the LLM never becomes the authorization authority.

Audit finding fixed:

- full mode previously had a Gateway shortcut for Codex-native approvals, creating two approval paths. Phase 8F routes all chat-confirmation decisions through `QqApprovalBroker -> AuthorizationAuthority` and performs trusted-owner auto approval only after policy acceptance.

Trusted deployment recommendation:

```text
machine ceiling = full
conversation mode = full
```

This removes routine approval friction for policy-accepted chat-confirmation actions without widening unsupported/allowlist/local-only boundaries.

### 4. Codex App Server integration — FEATURE-RICH, monolith risk

Observed strengths:

- typed RPC client and bounded timeouts;
- explicit failure classification;
- thread start/resume lifecycle;
- dynamic FLORAL tool namespaces;
- developer routing policy for System Awareness, extensions, delivery, Skills, GUI, and maintenance;
- frozen per-turn System Awareness snapshot avoids recursive state mutation and contradictory same-turn verification;
- explicit shell-bypass soft rejection for extension verification and GUI control.

Remaining risks:

- `codex-app-server.ts` is >4k lines and combines RPC lifecycle, dynamic tool parsing, policy prompt construction, approval routing, extension tooling, artifacts, Apps/Skills/MCP discovery, and event handling.
- future Codex App Server schema drift can therefore affect a wide surface in one module.

Recommendation (P1): split by protocol lifecycle, thread/turn lifecycle, dynamic tool hosts, extension discovery, approval bridge, and event normalization. Keep the current tests as compatibility contracts during the split.

### 5. DeepSeek bridge/provider — GOOD retry boundaries

Observed strengths:

- request timeouts and aborts;
- concurrency gate;
- pre-stream retry policy;
- cost guard/activity gate;
- errors normalized before reaching the Gateway.

Audit decision:

- do **not** add generic Gateway whole-turn auto retry. Once a turn has emitted a tool mutation, replay is not guaranteed idempotent. Retry belongs before side effects (provider/connection setup) or behind explicit operation-level idempotency.

UX improvement implemented: bounded error-kind-specific guidance tells the owner when a simple retry is appropriate and when to use diagnostics.

### 6. Configuration federation and service lifecycle — STRONG after recovery fix

Observed strengths:

- configuration ownership/classification model;
- locked machine-local ceiling keys;
- secret presence rather than value exposure;
- deterministic native config rendering/adoption reports;
- service state + actual PID liveness kept as separate evidence.

Audit finding fixed:

- `scripts/service.ts` previously required a fully valid application env before *any* command could execute, making status/logs unavailable exactly when config was broken.
- restart now validates replacement config before stopping the old instance.
- a common Phase 8D.1 ceiling-category typo has bounded compatibility handling and clear diagnostics.

Recommendation (P2): provide a `service:config:explain` compact command that prints only invalid/misplaced environment keys and the accepted enum/range, reusing the same validation source.

### 7. System Awareness / diagnostics — VERY STRONG

Observed strengths:

- definitions and snapshots are separated;
- evidence carries confidence/source/scope/time;
- `unknown` and `conflict` are first-class;
- contextual facts do not become fake unknowns outside their context;
- diagnostic findings remain derived hypotheses and are not fed back as evidence;
- current execution selector outranks Gateway request, which outranks configured default;
- diagnostic interfaces remain non-mutating.

Minor UX backlog:

- owner-facing `/system` and `/diagnose` outputs are optimized for machine fidelity and can be verbose.

Recommendation (P2): preserve the raw deterministic format under `/system --raw` / `/diagnose --raw`, but make default owner output a compact Chinese summary with counts, health, unknown/conflict rows, and a short evidence source section.

### 8. Self-maintenance — STRONG bounded transaction model

Observed strengths:

- bounded action schema rather than arbitrary shell command;
- host-side preflight diagnosis;
- post-reply handoff prevents the service from killing itself before replying;
- delivery failure cancels the handoff;
- new-PID + ready + liveness verification;
- single-flight maintenance transaction;
- owner-auto/self-heal ceilings, cooldown, rate limit, failure threshold, circuit breaker;
- self-heal validates whether the original finding disappeared rather than equating restart success with repair success.

No immediate code change required beyond Phase 8F trusted-owner approval centralization and documentation cleanup.

### 9. Controlled self-extension — STRONG, keep supply-chain authority narrow

Observed strengths:

- plan/apply/verify separated;
- Host recomputes the plan before applying a model-requested mutation;
- only curated MCP/Skill IDs and sources can mutate;
- Apps remain upstream/user-owned handoff;
- Plugin write lifecycle remains unsupported rather than silently bypassed;
- same-turn mutation never counts as fresh runtime verification;
- receipts avoid storing secrets/arbitrary shell commands.

Audit finding fixed:

- extension-manager Skill wording had drifted away from the exact verified-lifecycle/Plugin-handoff contract; restored in Phase 8F.

Trusted-owner UX improvement:

- in paired-owner `/mode full`, the existing one-shot `software.install` **chat-confirmation** can now be host-auto-approved after the curated plan and AuthorizationAuthority pass. The curated catalog remains the supply-chain boundary.

Recommendation (P2): if future usage shows repeated curated-extension management is still too chatty outside full mode, introduce a separate machine-local extension autonomy ceiling rather than reusing maintenance autonomy.

### 10. Storage and audit — GOOD

Observed strengths:

- SQLite WAL + foreign keys + busy timeout;
- transactional owner claim;
- durable inbound receipt dedup;
- conversation/project thread state separated;
- audit payload size bound.

Remaining risk:

- many operational audit writes are intentionally best-effort (`catch(() => undefined)`). This is appropriate for non-critical telemetry, but the distinction between “cosmetic audit” and “required transaction ledger” lives mostly in code convention. Phase 8F explicitly hardens Agent run-request/completion/failure and delivery-failure telemetry so a telemetry-store outage cannot suppress the user-visible task result or wedge a run slot.

Recommendation (P1): formalize two write classes:

```text
required ledger write  -> operation fails/does not advance without persistence
best-effort telemetry  -> operation continues, increments observable audit-drop counter
```

Maintenance/extension receipts already behave much closer to the required-ledger model; preserve that standard.

### 11. Workspace/project isolation — GOOD

Observed strengths:

- selected project and per-project Codex thread state;
- runtime namespace/profile isolation;
- bounded project names and existing-project resolution;
- shared context/memory has explicit owner commands.

Phase 8F queue-state blocking prevents queued tasks from being silently moved under a new project/mode via a command while they are waiting.

Recommendation (P1): when durable queue spooling is added, store the selected project/runtime namespace on each queue record and reject execution if that project has been removed before dequeue.

## Test architecture assessment

The suite is broad: Gateway/Codex/config/transport/approval/workspace/maintenance/System Awareness/extension behavior all have dedicated tests. The regressions reported after Phase 8E were primarily **contract drift** rather than missing functional coverage—an encouraging sign because the tests caught stale docs/Skill semantics quickly.

The main improvement needed is to make policy strings less fragile where possible while preserving exact assertions for phrases that are intentionally part of the Agent contract. For policy-critical routing phrases (`status=ready`, no shell verification, Plugin handoff), exact text assertions are reasonable. For descriptive prose, prefer structural helper tests or smaller constants rather than asserting long documentation paragraphs.

## Prioritized backlog

### P0 — release gate for this patch

1. Supported-machine `pnpm typecheck` = green.
2. Supported-machine full Vitest = green.
3. Build = green.
4. Mac `service:status` works even with the known misplaced ceiling value.
5. Correct `.env` to explicit remote/maintenance ceiling values after compatibility recovery is confirmed.
6. `/mode full` no longer shows chat approval for a curated `software.install` or Codex native command that AuthorizationAuthority accepts.
7. Two quick consecutive normal messages execute FIFO instead of dropping/overlapping.
8. `/stop` cancels active/preflight work and clears the queue.

### P1 — next reliability iteration

1. Durable outbound response outbox with duplicate-safe delivery semantics.
2. Durable/project-bound queued attachment spooling.
3. Persisted or machine-default owner control mode, always capped by remote ceiling.
4. Split Gateway and Codex App Server orchestration monoliths without behavior changes.
5. Required-ledger vs best-effort-audit write classification and observability.

### P2 — owner UX / observability

1. Compact human `/system` and `/diagnose`, raw form kept for machines.
2. Unified owner health dashboard (`service + Codex + transports + MCP + cost + queue`).
3. Optional extension autonomy ceiling for curated supply-chain changes, separate from maintenance autonomy.
4. Historical maintenance/extension receipt list commands rather than only latest receipt.

## Final audit conclusion

No architectural reason was found to roll back Phase 8. The control-plane model is sound. The immediate reliability problems came from edges between otherwise-correct subsystems: config enums vs service CLI, full-mode approval path duplication, active-run detection vs asynchronous preflight, and docs/tests lagging behind new lifecycle semantics.

Phase 8F should therefore stay an **integration hardening** release. The next large engineering task should be decomposition/durable delivery, not more Agent capability.
