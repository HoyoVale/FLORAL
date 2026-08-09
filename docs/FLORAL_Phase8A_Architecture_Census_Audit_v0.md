# FLORAL Phase 8A — Architecture Census & Authority Map

**Audit baseline:** `FLORAL(20260809-192453).zip`  
**Git baseline:** `947ccfd` — `App Directory & Extension Closure` (`main`, `origin/main`)  
**Audit mode:** source-level read-only review; no source files modified  
**Scope:** establish the factual architecture, ownership boundaries, state sources, management authority, approval boundaries, and evidence semantics required for Phase 8 System Awareness & Self-Management.

---

## 0. Executive conclusion

The repository is ready to enter Phase 8, but **not** by adding a larger system prompt and **not** by giving the Agent generic configuration mutation.

The existing implementation already contains most of the hard primitives Phase 8 needs:

- typed FLORAL capabilities and role-based authorization;
- owner-only / local-confirmation approval paths;
- configuration ownership classifications;
- requested/effective/rendered/installed/observed diagnostic layers;
- separate discovery and runtime evidence for Apps;
- curated Skill and MCP lifecycle managers;
- native runtime verification for MCP;
- process/service health primitives;
- project isolation and machine-local trust boundaries;
- durable audit events and identity/conversation state.

The missing piece is a **single machine-readable system model** that composes those primitives without collapsing their evidence lanes.

The central Phase 8 rule should be:

> **FLORAL may only claim a state at the authority level supported by evidence. Unknown is a valid state. Ownership, observation, health, and management authority are separate dimensions.**

The successful `/apps` behavior is already the correct prototype: `app/list` directory visibility does not become an installed/callable claim when `app/installed` is unavailable.

---

## 1. Repository census

| Area | Observed baseline |
|---|---:|
| `src/` | 108 files, ~31,610 code lines |
| `tests/` | 92 files, ~17,081 code lines |
| `scripts/` | 54 files |
| `docs/` | 45 files |
| built-in Skills | 5 |
| config artifacts | 7 files under `config/` |

Built-in Skill roots currently contain:

- `attachment-analysis`
- `extension-manager`
- `macos-ui-operation`
- `skill-manager`
- `system-status`

The checked-in `data/config/diagnostics/latest.json` is **historical evidence**, generated on 2026-08-06, not a live Phase 8 runtime snapshot. It must not be treated as current machine truth.

---

## 2. Current system topology

```text
User
  │
  ├─ Feishu / QQ / Mock transport
  │       │
  │       ▼
  │   GatewayService
  │       │
  │       ├─ Identity / pairing / conversation state ── SQLite
  │       ├─ AuthorizationAuthority
  │       ├─ LocalConfirmationBroker
  │       ├─ ArtifactEgressPolicy
  │       ├─ ProjectWorkspaceRoot / ProjectContext
  │       └─ AgentRuntime
  │                │
  │                ▼
  │      ManagedCodexDeepSeekRuntime
  │                │
  │                ├─ Codex App Server runtime(s)
  │                │      ├─ threads / turns / sandbox
  │                │      ├─ native Skills
  │                │      ├─ Apps
  │                │      ├─ Plugins feature state
  │                │      └─ MCP status/reload
  │                │
  │                ├─ DeepSeek provider/bridge
  │                ├─ External Skill registry/manager
  │                └─ External MCP registry/manager
  │
  └─ macOS host layer
          ├─ LaunchAgent / launchctl
          ├─ service-state.json + PID/liveness
          ├─ process lock
          ├─ Peekaboo
          ├─ SearXNG
          └─ local secrets/environment
```

A key architectural property is already explicit in `AGENTS.md`: FLORAL is a **thin gateway/control plane**, not a replacement agent framework. Codex owns agent threads, turns, tools, Skills, MCP and sandbox execution; FLORAL owns authorization policy and the controlled integration boundary.

---

## 3. Authority map v0

The table below is the first architecture census. `Management` describes what FLORAL can actually control today, not what would be convenient in Phase 8.

| Component / domain | Primary owner | Authoritative/current state source | FLORAL management today | Approval / boundary | Confidence notes |
|---|---|---|---|---|---|
| FLORAL process | FLORAL | live process + process lock | start/stop indirectly through host service scripts | local host | authoritative when live |
| LaunchAgent service | macOS + FLORAL wrapper | `launchctl` + `service-state.json` + PID liveness | CLI install/start/restart/stop/uninstall | machine-local | no Agent self-maintenance surface yet |
| configuration authority | FLORAL | resolved `ConfigurationAuthority` | typed overlays/render/adoption paths only | locked paths + env trust boundaries | authoritative for requested/effective FLORAL config |
| environment trust ceiling | machine owner | process environment (`FLORAL_REMOTE_MODE_CEILING`) | Agent cannot raise it | hard machine-local boundary | authoritative only from current process env |
| workspace root | machine owner | `FLORAL_WORKSPACE_ROOT` + canonical filesystem resolution | project selection beneath root | hard machine-local boundary | never infer from project config |
| Gateway identity/roles | FLORAL | SQLite owner bindings + identities | pairing / role resolution | owner policy | durable |
| conversation/thread mapping | FLORAL + Codex | SQLite mappings + Codex thread IDs | select/new/archive via supported surfaces | role/owner where mutating | content remains Codex-owned |
| Codex App Server | Codex upstream, FLORAL manages host process boundary | live App Server RPC + process state | start/stop with runtime lifecycle; supported RPCs only | no raw public exposure | runtime RPC beats config claims |
| Codex threads/turns | Codex | native App Server thread/turn RPC | run/interrupt/list/archive through wrappers | policy layer controls approvals | Codex-owned |
| Codex sandbox | Codex upstream under FLORAL policy | effective runtime request + Codex behavior | FLORAL selects bounded modes, does not replace sandbox | policy + machine ceiling | distinguish requested/effective |
| DeepSeek provider | provider/upstream; FLORAL adapter owns bridge | bridge/provider runtime + API responses | configure model/endpoint through authority; runtime use | secrets stay env-only | health needs live probe/result |
| native Codex memory | Codex | Codex native diagnostics/runtime | observe/use through Codex | no FLORAL duplicate ownership | separate from project memory |
| project durable memory | project owner / FLORAL files | `.floral/*.md` | explicit owner-only writes | no automatic writes | filesystem is truth |
| built-in FLORAL Skills | FLORAL | repository `skills/` + Codex discovery | immutable at runtime policy level | source-code change only | authoritative source tree |
| project Skills | project | `<cwd>/.agents/skills` + Codex discovery | project-scoped creation/use through Codex-compatible path | workspace/project boundary | native discovery is runtime truth |
| shared external Skills | FLORAL curated lifecycle over third-party packages | external Skill registry + checked-out package + Codex discovery | install/update/enable/disable/remove | `software.install`, owner approval | registry alone is not proof of runtime discovery |
| built-in MCP registry | FLORAL | typed MCP runtime registry + rendered Codex config | enable/configure only through FLORAL-owned config path | capability mapping required | registry defines intent/exposure |
| MCP runtime readiness | Codex runtime | `mcpServerStatus/list` + advertised tools | read status; shared external MCP can hot reload | mutation approval | **runtime verification is health truth** |
| `floral_search` | FLORAL gateway + SearXNG service | MCP runtime + SearXNG observed health | query; service managed outside Agent | `web.search` | distinguish MCP ready vs backend healthy |
| `floral_vision` | FLORAL gateway + MiMo provider | MCP runtime + MiMo request result | read-only visual analysis | `screen.capture`, trusted roots | attachment/screenshot trust domains separate |
| `floral_peekaboo` | FLORAL controlled gateway; Peekaboo owns GUI engine | MCP runtime + Peekaboo permissions/tool result | `image`, `see`, and approval-gated `click` | read vs `application.control` split | current catalog has stale control description |
| external GitHub MCP | third party / FLORAL curated integration | external registry + secret presence + Codex MCP runtime | install/enable/disable/remove/reload | `software.install`; auth secret env-only | ready only after runtime tools observed |
| external Chrome DevTools MCP | third party / FLORAL curated integration | external registry + Codex MCP runtime | install/enable/disable/remove/reload | `software.install`; mutating tools separately gated | ready only after runtime tools observed |
| Apps directory | Codex/OpenAI ecosystem | `app/list` | read + prepare install handoff | user-mediated auth/grants | directory visibility only |
| installed/callable Apps | Codex runtime | `app/installed` | read only today | upstream/user-mediated | fallback must leave callable unknown |
| App metadata/tools | Codex runtime/directory | `app/read` | read only | display metadata, not authority | tool summary != authorization grant |
| Plugins feature state | Codex upstream | `experimentalFeature/list` | observe only | production mutation RPC blocked | catalog/install RPC intentionally unsupported |
| Feishu transport | Feishu upstream + FLORAL adapter | worker/runtime connection + API result | start/stop adapter, receive/send text/media | credentials env-only; ingress policy | current catalog understates media support |
| QQ transport | QQ upstream + FLORAL adapter | SDK/runtime + API responses | start/stop adapter, text interaction | credentials env-only | compatibility transport |
| inbound attachments | Feishu + FLORAL materializer | authenticated ingress + private materialized files | bounded materialization | untrusted user content; trusted filesystem root only | image contents never gain authority |
| outbound artifacts | FLORAL policy + transport | ArtifactEgressPolicy + transport result | register/send through `floral_delivery` | egress policy | local existence != successful delivery |
| cost guard | FLORAL | process/runtime counters | enforce current run budgets | policy | live-process state |
| `/mode` control mode | FLORAL gateway | in-process map | owner can request bounded mode changes | machine ceiling + approval | **currently process-memory, not restart-durable** |
| audit log | FLORAL | SQLite `audit_events` | append/read through code paths | policy | action history, not current-state authority |

---

## 4. Existing evidence model is stronger than it first appears

Two existing designs should be promoted into Phase 8 rather than replaced.

### 4.1 Configuration diagnostic layers

`config-diagnostics.ts` already formalizes these layers:

```text
requested
→ effective
→ rendered
→ installed
→ observed
```

That is exactly the right idea for System Awareness: a desired setting, a rendered artifact, an installed artifact and a live observation are different facts.

### 4.2 App discovery/runtime split

The current App code models:

```text
app/list       -> directory / accessibility / install handoff
app/installed  -> effective installed + callable runtime state
app/read       -> metadata/tool summary
```

When `app/installed` is unsupported, the fallback source becomes `directory-fallback` and `callable` is omitted/unknown. The tests explicitly protect this behavior.

This should become the canonical Phase 8 evidence rule, not an App-specific exception.

---

## 5. What FLORAL already does well enough to reuse directly

### 5.1 Authorization is already a real control plane

`Capability` currently includes:

- `machine.status.read`
- `screen.capture`
- `files.read/write/delete`
- `shell.execute`
- `software.install`
- `application.open/control`
- `browser.submit`
- `message.send`
- `web.search`
- `codex.permission.grant`
- `system.restart`
- `system.admin`

The Phase 8 management layer should **reuse these capabilities** rather than introduce a second authorization vocabulary.

### 5.2 MCP capability coverage is explicit

Active MCP tools must map to a FLORAL capability. The current registry/policy already distinguishes read-only visual observation from `floral_peekaboo/click -> application.control`.

### 5.3 Extension mutation and verification are already separated

For shared external MCP, mutation is performed through FLORAL's curated control plane, followed by native reload. The current turn is deliberately not allowed to use stale pre-mutation state as proof; next-turn native MCP status is required for verification.

This is an excellent prototype for all future self-maintenance:

```text
request action
→ authorize
→ mutate through owned control plane
→ invalidate stale evidence
→ obtain fresh authoritative observation
→ declare success/failure/unknown
```

### 5.4 Secrets already have the correct boundary

Secret values come from environment/machine-local configuration. Configuration authority and extension status can expose only presence/reference semantics. Phase 8 must preserve this: SystemSnapshot may say `present/missing/unknown`, never carry credential values.

---

## 6. High-priority architecture findings

### P0-1 — `upstream-config-catalog.json` is useful inventory, but it is already stale

It must **not** become the Phase 8 System Map authority.

Two concrete drifts are visible in the current baseline:

1. **Peekaboo control drift**  
   The catalog still marks Peekaboo `control` as `locked`, coverage `disabled`, including `click`. Current runtime configuration and policy enable `floral_peekaboo/click` as an approval-gated controlled mutation and map it to `application.control`.

2. **Feishu media drift**  
   The catalog still lists `files and images` as future protocol capabilities and says the first cutover is P2P text only. Current Feishu transport implements bounded inbound image/file materialization and outbound native image/file upload/send, and Phase 6A4 documents trusted inbound vision.

**Consequence:** the old catalog can seed static definitions, but System Awareness needs compile-time/tested definitions plus live observers. Documentation JSON alone is not trustworthy enough.

### P0-2 — There is no unified `SystemDefinition` / `SystemSnapshot`

Today the Agent must mentally combine:

- `/status`
- `/skills`
- `/apps`
- `/mcp`
- `/plugins`
- configuration diagnostics
- external registries
- service scripts/state files
- transport runtime state
- Codex native RPCs
- macOS permissions/probes

No single contract answers:

> What components exist, who owns them, what is their current state, where did that state come from, and what may FLORAL do about it?

This is the primary Phase 8A implementation gap.

### P0-3 — System knowledge is partly duplicated as prose in `FLORAL_AGENT_DEVELOPER_INSTRUCTIONS`

The current developer instructions contain correct but hand-maintained routing rules for Skills, Apps, MCP, Plugin restrictions, visual operation and verification semantics.

That was appropriate through Phase 7, but it is not scalable as the system-awareness layer. A larger prompt would create two competing sources of truth:

```text
code/policy state
vs.
prompt description of code/policy state
```

Phase 8 should make the prompt smaller and more invariant over time, with current facts obtained from a typed read-only system surface. **Do not perform that prompt refactor in the first 8A patch; first establish the map and tests.**

### P0-4 — Health state has no common semantics

Different domains currently use different notions of status:

- service: loaded + state-ready + PID alive;
- MCP: starting/ready/failed/cancelled/unknown;
- Apps: installed/enabled/callable with fallback unknown;
- config: match/drift/not-installed/observed/error;
- external MCP: registry enabled + auth presence + separate runtime readiness;
- transports: startup/worker/API behavior;
- providers: request success/failure.

These should remain domain-specific observations, but Phase 8 needs a conservative common roll-up vocabulary such as:

```text
healthy | degraded | unavailable | blocked | unknown | not_applicable
```

The roll-up must retain raw evidence and must never turn `unknown` into `healthy`.

### P1-1 — Service lifecycle exists, but Agent self-maintenance does not

The repository already has robust local scripts for `doctor/install/start/status/restart/stop/recovery-probe/uninstall`, plus a `system.restart` capability.

However, there is currently no Agent-facing, authorization-gated service maintenance adapter. This is good: it means Phase 8D can be added deliberately instead of inheriting an accidental shell backdoor.

### P1-2 — Management action semantics are not modeled as data

Skills and external MCP each encode their own management operations. Service scripts encode another lifecycle. Projects have their own mutations.

Phase 8 needs a shared **description** of allowed actions, for example:

```text
restart
reload
enable
disable
install
update
remove
repair
```

But execution should remain delegated to component-specific adapters. There should be **no generic arbitrary config write action**.

### P1-3 — `/mode` is a live control state but is process-memory only

Gateway control mode is stored in an in-process map. That is a valid design today, but System Awareness must label it as:

```text
scope = process
persistence = none
```

Otherwise an Agent could incorrectly tell the owner that a mode choice survives service restart.

### P1-4 — Audit history is not a state snapshot

SQLite `audit_events` is useful for “what happened”, but it must not be queried as “what is true now”. Phase 8 should explicitly distinguish:

```text
event history
vs.
current observation
```

---

## 7. Proposed Phase 8 canonical data model

This is a design proposal for the next patch, not yet code.

### 7.1 `SystemDefinition`

Static contract: what a component **is allowed to mean**.

```ts
type SystemOwner =
  | "floral"
  | "codex"
  | "os"
  | "transport-provider"
  | "model-provider"
  | "third-party"
  | "project"
  | "user";

interface SystemDefinition {
  id: string;
  kind: string;
  owner: SystemOwner;
  authority: string;
  stateSources: string[];
  healthSources: string[];
  secretDependencies: string[]; // names/refs only
  failureDomains: string[];
  managementActions: ManagementActionDefinition[];
}
```

### 7.2 `SystemEvidence`

A single observation must carry its source and epistemic strength.

```ts
type EvidenceConfidence =
  | "authoritative"
  | "observed"
  | "inferred"
  | "unknown";

interface SystemEvidence<T = unknown> {
  source: string;
  scope: string;
  observedAt: string;
  confidence: EvidenceConfidence;
  value?: T;
  error?: string;
}
```

Important: `authoritative` means authoritative **for that fact**, not for the whole component. `app/list` can be authoritative for directory visibility while still saying nothing authoritative about callable runtime state.

### 7.3 `SystemSnapshot`

Dynamic current-state aggregation.

```ts
interface SystemComponentSnapshot {
  id: string;
  health: "healthy" | "degraded" | "unavailable" | "blocked" | "unknown" | "not_applicable";
  evidence: SystemEvidence[];
  stale: boolean;
}

interface SystemSnapshot {
  generatedAt: string;
  processInstanceId: string;
  components: SystemComponentSnapshot[];
}
```

A snapshot must be explicitly ephemeral. It is not configuration and should not silently become persisted desired state.

### 7.4 `ManagementActionDefinition`

Describe permission without creating a generic executor.

```ts
interface ManagementActionDefinition {
  action: string;
  capability: Capability;
  approval: "automatic" | "chat-confirmation" | "local-confirmation" | "forbidden";
  executor: string;       // named owned adapter
  verification: string;   // named fresh observer
  restartSemantics?: "none" | "hot-reload" | "service-restart" | "host-restart" | "unknown";
}
```

This allows the Agent to know “I can request restart” without gaining `shell.execute("launchctl ...")` as an implementation shortcut.

---

## 8. Recommended Phase 8A implementation boundary

The first code patch should stay **read-only** and intentionally small.

### 8A.1 — Define contracts

Add typed definitions for:

- component definition;
- evidence;
- health roll-up;
- management action metadata;
- snapshot.

No mutations.

### 8A.2 — Build static `SystemDefinitionRegistry`

Populate it from current architecture facts, initially covering at least:

- FLORAL host/service;
- configuration authority;
- workspace/project boundary;
- transport;
- Codex runtime;
- DeepSeek provider;
- Skills;
- Apps;
- Plugins;
- built-in MCP;
- external MCP;
- SearXNG;
- Vision/MiMo;
- Peekaboo;
- storage/audit.

The old upstream catalog should be **referenced/validated**, not copied as authority.

### 8A.3 — Add observer adapters

Observers should call existing supported APIs and return evidence, not mutate state. Start with cheap/high-confidence observers:

1. configuration authority summary;
2. service/process instance metadata available inside the process;
3. active transport identity/type;
4. Codex runtime identity;
5. native MCP status;
6. App installed/directory evidence lanes;
7. Skill discovery;
8. external Skill/MCP registry state;
9. workspace/project selection;
10. secret **presence** only.

Do not make expensive external health probes run automatically on every chat turn.

### 8A.4 — Add `SystemSnapshotBuilder`

The builder combines evidence without overwriting contradictions. For example:

```text
external MCP registry enabled=true
+ secret present=true
+ native MCP status=failed

=> component health=unavailable/degraded
   not "installed and ready"
```

### 8A.5 — Add read-only inspection surface

Only after contracts/builders exist:

```text
floral_system/system_summary
floral_system/component_status
floral_system/capabilities
```

and optionally:

```text
/system
/system <component>
```

This surface must expose facts and authority, not generic mutation.

### 8A.6 — Tests

Required regression families:

- evidence lanes never promote weaker evidence;
- unknown remains unknown;
- stale evidence is marked;
- secret values never enter snapshots;
- directory App never becomes callable without installed-runtime evidence;
- external MCP registry enabled does not imply ready;
- disabled/blocked management action is accurately reported;
- ownership and management authority are independent;
- no system snapshot builder executes mutation commands;
- old catalog drift is caught by explicit tests or removed from claims it no longer owns.

---

## 9. Explicitly defer from 8A

Do **not** add these in the first patch:

- service restart from chat;
- automatic repair;
- automatic package installation;
- arbitrary config writes;
- raw shell fallback for management;
- automatic Git operations;
- dynamic escalation of `FLORAL_REMOTE_MODE_CEILING`;
- dynamic change of `FLORAL_WORKSPACE_ROOT`;
- credential retrieval or display;
- Plugin experimental RPC mutation;
- a giant replacement developer prompt.

Those belong to 8C–8E only after the read-only system model has proven trustworthy.

---

## 10. Proposed Phase sequence after this audit

```text
8A — System Definition + Snapshot foundation (read-only)
  ↓
8B — Runtime Self-Awareness
     Agent consumes current snapshot instead of memorizing architecture prose
  ↓
8C — Self-Diagnostics
     evidence-backed causal diagnosis + owner-facing remediation plan
  ↓
8D — Controlled Self-Maintenance
     explicit component adapters: restart/reload/repair with approval + verification
  ↓
8E — Controlled Self-Extension
     capability-gap detection → curated extension → approval → install → fresh verification
```

The order matters. 8E before 8A–8D would create an Agent that can change its environment without a reliable model of state or authority.

---

## 11. Recommended acceptance decision

**Architecture audit verdict: APPROVE Phase 8A foundation work, with two mandatory corrections before System Map is treated as authoritative:**

1. Do not use `config/catalog/upstream-config-catalog.json` as the system source of truth; explicitly resolve its current Peekaboo and Feishu capability drift.
2. Preserve multi-lane evidence semantics everywhere; never collapse configured/installed/visible/enabled/ready/callable into one boolean.

The source baseline shows no architectural blocker requiring a Phase 7 rollback. The correct next move is a new read-only system-awareness foundation, not more extension work.

---

## 12. Validation limitation of this audit environment

The ZIP contains no `node_modules`. Node.js is available, but invoking Corepack/pnpm attempted to reach the public npm registry and failed because this audit environment has no network access. Therefore this report makes **no new claim that the current baseline builds or passes tests inside this sandbox**.

The audit is source-grounded. The user's real-host `/apps` result separately provides live evidence that the current directory-fallback/callable-unknown behavior works on the deployed runtime.
