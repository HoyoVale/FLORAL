# Phase 8F — Trusted Owner Reliability & UX

Status: implementation candidate on baseline `a6befa1` (`Phase 8E + 8D fixup`).

## 1. Goal

Phase 8F is a reliability/experience pass over the completed Phase 8 control plane. It does not create another extension or maintenance authority. It tightens the existing boundaries while removing avoidable friction for the paired owner on a trusted Mac.

The design target is:

```text
trusted owner intent
    ↓
existing FLORAL authority / allowlist / curated plan
    ↓
chat-confirmation can be automatic in /mode full
    ↓
local-only / unsupported / unallowlisted boundaries remain host-governed
```

This is deliberately different from disabling authorization. The model still cannot grant itself capabilities or bypass curated lifecycle routes.

## 2. Release-blocking regressions closed

### 2.1 Extension-manager Skill contract drift

The Phase 8E Skill rewrite lost several explicit runtime-verification and Plugin-handoff strings that existing regression tests use as policy contracts.

The Skill once again states explicitly:

- fresh MCP readiness means `status=ready` with non-empty tools;
- the current turn's `mcp_status` snapshot cannot verify a same-turn mutation;
- do not inspect `~/.codex` or ask for a second shell approval to verify an extension;
- GitHub credentials stay machine-local and the owner must not paste the secret into chat;
- Plugin installation remains the Codex CLI `/plugins` browser handoff;
- App Server `plugin/list` / write RPCs are not the production path;
- `verification pending` and `verified` remain distinct lifecycle states.

### 2.2 Diagnostics maintenance flag drift

After Phase 8D/8D.1, a separately governed `floral_system/maintain` surface exists. Tests that still expected `maintenance_enabled=false` were stale.

The current contract is:

```text
execution_performed=false
maintenance_enabled=true   # when governed maintenance surface is declared/available
```

`maintenance_enabled=true` does not mean a diagnostic call executed a repair. It only reports availability of the separate governed mutation surface.

Historical Phase 8C/8D documents now carry a supersession note to prevent future maintainers or Agents from reviving the old overloaded meaning.

### 2.3 Remote/maintenance ceiling configuration confusion

Phase 8D.1 introduced two deliberately distinct machine-local ceilings:

```text
FLORAL_REMOTE_MODE_CEILING=auto|full
FLORAL_MAINTENANCE_MODE_CEILING=manual|owner-auto|self-heal
```

Putting `owner-auto` or `self-heal` into the older remote-mode slot previously made every `service:*` command fail during top-level environment parsing.

Phase 8F adds bounded compatibility handling for exactly this category mismatch:

- the remote ceiling falls back to safe `auto`;
- when no explicit maintenance ceiling exists, the recognizable maintenance value is carried to the maintenance slot;
- an explicit maintenance ceiling is never overwritten;
- unknown values still fail validation;
- startup/service CLI prints a compatibility notice.

The main process also synchronizes the normalized non-secret machine ceiling values back into its own `process.env` so host-owned managers that intentionally consume `process.env` do not see a stale, invalid value later in startup.

`.env.example` now states the valid value domains next to the two variables.

## 3. Service CLI recovery behavior

`service:status` and other recovery commands must be most useful when configuration is broken. Previously `scripts/service.ts` loaded and validated the entire runtime environment at module load, so an invalid `.env` prevented even status/log inspection.

Phase 8F separates service command classes.

### Commands requiring a valid runtime configuration

```text
service:doctor
service:install
service:start
service:restart
service:recovery:probe
```

### Recovery commands that remain available under invalid runtime configuration

```text
service:status
service:logs
service:stop
service:uninstall
```

`service:status` now emits:

```text
service.config=ok|invalid
service.config_error=<bounded redacted summary>
```

Most importantly, `service:restart` validates configuration **before** stopping the currently loaded LaunchAgent. A typo can no longer turn a healthy old instance into an avoidable outage before the replacement configuration has passed validation.

## 4. Paired-owner trusted full mode

The old full-mode path had a special case that approved Codex-native command/file/permission requests in `GatewayService` before they passed through the common approval broker.

That shortcut worked, but it created two authorization paths and made future policy drift more likely.

Phase 8F removes the shortcut. All prompt-level mutation requests now converge on:

```text
Agent / MCP / Skill / Extension request
    ↓
QqApprovalBroker
    ↓
AuthorizationAuthority
    ↓
role / sandbox exception / MCP allowlist / curated source checks
    ↓
approval level
```

When all of the following are true:

```text
role = owner
conversation mode = full
machine remote ceiling = full
approval level = chat-confirmation
```

then the broker can return a trusted-owner automatic approval without presenting an approval card.

This now covers policy-accepted chat confirmations such as:

- Codex native command/file/structured permission requests;
- controlled GUI mutation;
- allowlisted MCP submission/control actions;
- curated External Skill/MCP `software.install` lifecycle actions;
- other capabilities whose declared approval level is chat-confirmation.

It does **not** auto-approve:

- `system.restart` / `system.admin` solely because full mode is active;
- unsupported or unallowlisted MCP tools;
- arbitrary package sources;
- Plugin write RPCs that FLORAL does not expose;
- artifact egress denied by ArtifactEgressPolicy;
- operations rejected by role/capability policy.

The System Awareness route name is now `full-auto-owner-trusted`, making the real semantics visible in `/status --debug` and `floral.execution`.

## 5. Conversation backpressure instead of dropped follow-ups

Previously, a normal message arriving while an Agent run was active received a warning and was discarded. In real chat use this is frustrating: users naturally send a correction or second instruction before a long task ends.

Phase 8F adds a bounded per-conversation FIFO queue:

```text
maximum queued normal messages = 3
```

Behavior:

- a follow-up message is queued rather than dropped;
- the user sees `已排队（n/3）`;
- `/status` exposes `runs_queued` / `排队消息`;
- the queue drains automatically after the current run finishes;
- `/stop` clears queued follow-ups as well as stopping the active run;
- exceeding the bound fails visibly rather than growing memory without limit.

### Preflight race closure

There was a subtler race before `#activeRuns` was populated: project/thread lookup and attachment preparation contain asynchronous waits. Two messages arriving almost simultaneously could both pass the old `active` check and start overlapping Codex turns for one conversation.

Phase 8F adds an explicit `startingAgentRuns` reservation before the first asynchronous preflight read. Follow-ups see the reservation and queue immediately.

`/stop` can also cancel a run while it is still in this preflight state and clear any queued follow-ups, so a user is not forced to wait until Codex creates a thread before cancellation becomes effective.

State-changing conversation commands (`/new`, project switching, mode switching, project memory/context mutations, etc.) now treat active + starting + queued work as busy. This avoids silently changing the project/mode underneath messages already waiting in the FIFO.

## 6. Actionable Agent-failure UX

The previous fallback was essentially:

```text
任务执行失败，请在 Mac 本地查看服务日志。
```

That is safe but unnecessarily expensive for routine transient failures.

Phase 8F maps bounded Codex error categories to user actions without exposing raw provider errors or secrets:

- network/provider → retry; diagnose `codex.runtime` if persistent;
- timeout → retry or split the task;
- authentication → inspect machine-local provider credentials;
- usage limit → inspect `/status --debug` cost/request state;
- sandbox → inspect `/mode`, use trusted full mode only when intended;
- process exit → retry, then diagnose runtime/logs;
- bad request/protocol → `/new` and retry, then diagnose if reproducible;
- unknown → retry once, then use System Diagnostics.

Blind whole-turn automatic retry is intentionally **not** introduced: a partially completed Agent turn can already have performed side effects, so replaying the whole turn is not generally idempotent.

Run lifecycle audit rows (`agent.run_requested`, `agent.run_completed`, `agent.run_failed`) are treated as best-effort telemetry rather than a prerequisite for replying to the owner. A temporary audit-store write failure therefore cannot wedge the conversation reservation, suppress a successful Agent reply, or replace an actionable Agent failure reply with an internal persistence error. Transactional maintenance/extension receipts remain governed ledgers and are not downgraded to best-effort telemetry.

## 7. Prompt/tool routing reinforcement

The System Awareness and extension prompts continue to make FLORAL-native control planes primary:

- System health → `floral_system/diagnose` first;
- FLORAL current execution state → `floral_system/current_context`;
- extension gap → `floral_extensions/plan_extension` first;
- exact controlled mutation → `apply_extension` only when the plan permits it;
- post-mutation validation → fresh-turn `verify_extension`;
- GUI mutation → controlled Peekaboo tool when currently available;
- no shell/config/package-manager imitation of a missing control plane.

The new full-mode wording explicitly says that trusted-owner automatic approval is a **host policy**, not permission for the model to label its own requests trusted.

## 8. Validation performed in the audit environment

The uploaded dependency tree contains Windows native packages (`@rollup/rollup-win32-*`, `@esbuild/win32-x64`) while the audit runner is Linux, so a trustworthy full Vitest run cannot be claimed here.

The following checks were performed instead:

```text
git diff --check                                      PASS
modified production source strict TypeScript check   PASS
modified regression tests strict TypeScript check    PASS
ENV_COMPAT_SMOKE                                      PASS
TRUSTED_APPROVAL_SMOKE                                PASS
GATEWAY_PREFLIGHT_QUEUE_SMOKE                         PASS
GATEWAY_PREFLIGHT_STOP_SMOKE                          PASS
```

A repository-wide `tsc` invocation reaches the known platform/dependency-tree DOM/fetch typing errors in unrelated bridge/provider/test files. No errors were reported for the Phase 8F modified production/test files in the targeted strict checks.

The release gate remains the supported machine:

```text
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

## 9. Recommended trusted-owner machine setup

For a Mac whose chat users are deliberately trusted, a practical setup is:

```env
FLORAL_REMOTE_MODE_CEILING=full
FLORAL_MAINTENANCE_MODE_CEILING=owner-auto
```

Then use `/mode full` in the conversation when you want frictionless policy-approved chat-confirmation actions.

Choose `self-heal` for the maintenance ceiling only when autonomous deterministic repair is desired. Full mode and maintenance autonomy remain separate on purpose.

## 10. Not changed in Phase 8F

- No unrestricted sudo or Keychain access.
- No arbitrary extension repository/package source.
- No Plugin write-RPC bypass.
- No model-controlled elevation of machine ceilings.
- No removal of ArtifactEgressPolicy.
- No blind whole-turn retry after side effects.
- No large-scale split of `gateway.ts` or `codex-app-server.ts` in the same reliability patch.

Those boundaries keep trusted-owner convenience high without turning the model itself into the authorization authority.
