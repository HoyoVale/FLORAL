# Phase 8B — Runtime Self-Awareness

Status: implementation candidate for Windows + macOS release-gate validation
Date: 2026-08-10

## Goal

Phase 8A gave FLORAL a read-only system map. Phase 8B changes how the Agent reasons about that map: current runtime claims must come from per-turn evidence rather than from hand-maintained prompt prose or generic model environment text.

Phase 8B does **not** enable self-maintenance. It adds no restart/install/remove/write authority.

## Validation finding that triggered 8B

The Phase 8A.5 Mac validation correctly exposed a semantic mismatch:

- Configuration Authority reported the configured Codex defaults (`sandbox=read-only`, `approval=never`).
- The active Gateway conversation could request another execution mode (`workspace-write` or `danger-full-access`).
- A project runtime can select the Codex-native named permission profile `floral-project`, in which case that profile—not the legacy sandbox request—is the exact selector sent on `turn/start`.
- Generic Codex/model environment prose may describe its own execution context, but that prose is not a FLORAL System Awareness authority source.

Without a dedicated runtime evidence lane, the Agent could only place these strings side-by-side. It could not say which one described configuration intent, which one described Gateway request intent, and which one described the exact Codex turn selector.

## Authority model

Phase 8B adds the `floral.execution` component with two separate authoritative lanes.

### 1. `gateway-execution-policy`

Conversation-scoped FLORAL Gateway request intent:

- `gateway.control_mode`
- `gateway.requested_sandbox`
- `gateway.requested_approval_policy`
- `gateway.requested_approvals_reviewer`
- `gateway.approval_route`

These facts answer: **what did the Gateway request?**

They do not prove which Codex permission selector was ultimately emitted by the runtime.

### 2. `codex-turn-execution`

Per-turn FLORAL runtime facts captured immediately before `turn/start`:

- `turn.selector = sandbox-policy | permission-profile`
- `turn.sandbox_mode`
- `turn.permission_profile`
- `turn.approval_policy`
- `turn.approvals_reviewer`

These facts answer: **what execution selector did FLORAL actually construct for this Codex turn?**

When `turn.selector=permission-profile`, `turn.sandbox_mode=not-applicable`; the named profile is the effective selector FLORAL sent. The upstream Codex App Server API documents `permissions` profile selection as preferred for permission overrides and states that it cannot be combined with legacy `sandboxPolicy`.

Upstream reference:

`https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md`

## Precedence rule

For FLORAL self-description:

```text
turn-effective-selector
> gateway-request
> configured-default
```

This is not a generic security precedence rule outside FLORAL. It is the evidence precedence used when answering the specific question, “what execution policy is this FLORAL turn using?”

Configured defaults remain valuable configuration facts. They simply must not be mislabeled as the current turn selector.

## New read-only tool

The existing `floral_system` client-hosted namespace gains:

```text
floral_system/current_context
```

It renders the frozen `floral.execution` evidence for the current turn. The Agent is instructed to consult it before making claims about:

- current FLORAL control mode;
- Gateway-requested sandbox;
- exact Codex turn selector;
- named permission profile;
- approval policy;
- approvals reviewer.

Like every Phase 8 System Awareness tool, it is read-only and operates on the pre-turn frozen snapshot.

## Contextual facts

Execution facts exist only when the relevant context exists. State sources can now be marked:

```text
availability=contextual
```

A contextual source that emitted no evidence is omitted from fact materialization instead of being converted into a misleading `unknown` count.

Examples:

- `/system` has a Gateway conversation context, so `gateway.*` can be present.
- `/system` does not start an Agent turn, so no `turn.*` facts are fabricated.
- During an Agent turn, both Gateway request facts and exact Codex turn facts are available.

`unknown` remains a valid first-class state when a contextual source exists and explicitly reports that a value cannot be established.

## Prompt migration

Phase 8B begins shrinking the static architecture knowledge carried in developer instructions.

The prompt keeps stable routing and safety invariants, such as:

- do not bypass governed GUI routes;
- do not bypass extension lifecycle controls through shell/config edits;
- use FLORAL delivery registration before claiming an artifact was sent.

Dynamic claims such as “which extension is currently ready” or “what exact permissions this turn has” are redirected to `floral_system`.

The runtime self-awareness policy explicitly states:

- developer instructions are not current-state evidence;
- configuration defaults are not automatically the current turn selector;
- generic model/Codex environment prose is not a FLORAL System Awareness authority source;
- the frozen snapshot must not be silently refreshed or upgraded by guesswork;
- self-maintenance remains disabled.

## Gateway language correction

Owner-facing mode/status text now labels sandbox, approval policy, and reviewer as **requested** values where appropriate. This prevents `/status --debug` from implying that a Gateway sandbox request necessarily equals the effective project-runtime permission selector.

For a project runtime using `floral-project`, the expected shape is:

```text
gateway.control_mode = full
gateway.requested_sandbox = danger-full-access
turn.selector = permission-profile
turn.permission_profile = floral-project
turn.sandbox_mode = not-applicable
```

That is not a conflict. It is a deliberate separation between Gateway request intent and the Codex-native project-isolation selector.

## Security boundary

Phase 8B adds observation only.

It does not add:

- service restart tools;
- arbitrary shell access;
- config mutation;
- extension lifecycle authority;
- approval bypass;
- a mechanism for the model to alter `floral.execution` evidence.

The execution context is constructed by trusted FLORAL host code before the turn and then frozen into the snapshot.

## Regression coverage

The implementation adds/updates tests for:

1. authoritative separation of Gateway request vs exact Codex turn selector;
2. a project `floral-project` permission profile superseding the Gateway sandbox request in `turn.*` facts;
3. `floral_system/current_context` dynamic-tool exposure and content;
4. contextual execution sources not inflating `unknown` counts when no turn exists;
5. `/system` receiving Gateway context without starting an Agent turn;
6. full-mode Agent requests carrying explicit `controlMode` and `approvalRoute` metadata;
7. owner-facing debug status using `requested_*` labels.

## Release gate

On Windows, after applying this patch to the Phase 8A.5 baseline:

```powershell
git apply --check .\FLORAL-Phase8B-runtime-self-awareness.patch
git apply .\FLORAL-Phase8B-runtime-self-awareness.patch

corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

After the owner commits/pushes and the Mac mini performs `git pull --ff-only`, validate:

```text
/system
/system floral.execution
/status --debug
/new
```

Then ask the new Agent thread:

```text
检查当前这个回合实际使用的执行权限。区分 Gateway 请求、Codex turn 的实际 selector、配置默认值，并说明证据来源。不要执行任何修改。
```

For a project runtime, the key acceptance condition is that the Agent uses `floral_system/current_context` and reports the named `floral-project` permission profile as the `turn.selector=permission-profile` result when that is what FLORAL sent. It must not describe `danger-full-access` as the effective turn sandbox merely because the Gateway requested full mode.

## Phase boundary

Once this release gate is green, Phase 8B can close. Phase 8C should then build **Self-Diagnostics** on top of the same evidence model: derive bounded diagnoses and remediation plans from conflicting/missing/unhealthy facts, still without executing maintenance actions.
