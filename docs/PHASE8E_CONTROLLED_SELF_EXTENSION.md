# Phase 8E — Controlled Self-Extension

Status: implementation candidate

## Objective

Phase 8E lets FLORAL recognize an extension capability gap, build a deterministic lifecycle plan from its frozen System Awareness evidence, request the existing governed approval for an exact curated mutation, and verify the result from a fresh turn.

It does **not** give the model a package manager, arbitrary Git access, Codex config write access, Plugin write RPCs, credential access, or permission to silently authenticate an App.

The control loop is:

```text
capability request / gap
        ↓
floral_extensions/plan_extension        (read-only)
        ↓
exact curated plan
        ↓
apply_extension                          (External MCP / Skill only)
        ↓
software.install one-shot approval
        ↓
existing bounded manager
        ↓
ExtensionControlLedger receipt
        ↓
current turn ends: verification pending
        ↓
fresh SystemSnapshot
        ↓
floral_extensions/verify_extension      (read-only runtime verification + receipt update)
        ↓
verified / prerequisite-required / degraded / pending
```

Apps follow a different ownership path:

```text
plan_extension(kind=app)
        ↓
user-handoff
        ↓
prepare_app_install
        ↓
Codex/OpenAI supported install/auth surface
        ↓
user completes upstream action
        ↓
fresh turn verify_extension
```

## New controlled extension tools

### `floral_extensions/plan_extension`

Inputs:

- `kind`: `mcp | skill | app`
- `id`: exact target id
- `intent`: `activate | update | disable | remove` (defaults to `activate`)

Possible plan states:

- `action-required`
- `no-op`
- `prerequisite-required`
- `diagnose-first`
- `user-handoff`
- `unknown`
- `unsupported`

The plan is deterministic output derived from the frozen System Awareness snapshot and the curated catalog contract. It is not authorization.

### `floral_extensions/apply_extension`

Inputs:

- `kind`: `mcp | skill`
- `action`: `install | update | enable | disable | remove`
- `id`: exact curated target id

The host recomputes the extension plan from the current frozen System Awareness snapshot. Mutation is accepted only when:

```text
plan.status == action-required
AND
plan.recommended_action == requested action
```

The existing one-shot `software.install` approval remains mandatory. The model cannot submit arbitrary package URLs, repositories, refs, commands, executables, environment variables, or Codex configuration fragments through this interface.

For External MCPs, the existing `ExternalMcpHostManager` remains the lifecycle owner. For External Skills, the existing `ExternalSkillManager` remains the lifecycle owner. Phase 8E is an orchestration/control layer, not a replacement installer.

### `floral_extensions/verify_extension`

Verification reads the latest controlled-extension transaction from the **fresh turn's frozen System Awareness snapshot** and checks the owning state sources.

External MCP verification combines:

- FLORAL External MCP registry state;
- credential presence metadata when required;
- expected Codex MCP server id;
- Codex MCP runtime status;
- discovered tools.

External Skill verification combines:

- FLORAL External Skill registry state;
- expected Skill names captured from the validated curated checkout;
- Codex Skill discovery state.

App verification combines:

- `app/installed` authority when supported;
- callable state;
- explicit preservation of unknown/user-mediated state when upstream installation/authentication is not yet observed.

Verification does not use shell, direct filesystem probing, process inspection, package storage inspection, or nested runtime mutation.

## Extension Control Ledger

Phase 8E adds the machine-local component:

```text
floral.extension_control
```

Authority:

```text
ExtensionControlLedger
```

State source:

```text
extension-control-ledger
```

The ledger writes private transaction receipts under FLORAL's data directory:

```text
<data_dir>/extension-control/
  latest.json
  transactions/<id>.json
```

Receipts contain bounded lifecycle metadata only:

- transaction id;
- kind;
- target id;
- action;
- status;
- timestamps;
- whether a mutation changed state;
- expected MCP server id or validated Skill names;
- bounded verification label;
- bounded error type when relevant.

They never contain:

- secret values;
- PATs/API keys;
- shell commands;
- arbitrary source URLs supplied by the model;
- package-manager command lines;
- App authentication tokens.

Malformed ledger content is not interpreted as an authoritative empty state. The observer fails closed and System Awareness keeps the affected evidence unknown/observer-failed.

## Fresh-turn rule

The Phase 8A/8B frozen-snapshot rule remains mandatory.

A mutation can happen after the current turn snapshot was captured. Therefore:

```text
apply/handoff success
!=
verified runtime adoption
```

The same turn must end with verification pending. The next turn obtains a new System Snapshot and calls `verify_extension`.

The developer instructions and `extension-manager` Skill explicitly forbid compensating with:

- `~/.codex` inspection;
- process-table inspection;
- `data/external-*` registry inspection;
- shell/git/npm/pnpm package installation;
- `codex mcp` / `codex plugin` commands;
- direct Codex config edits.

## Ownership boundaries

### External MCP

Third party owns implementation/upstream service. FLORAL owns curated installed/enabled metadata and the bounded lifecycle manager. Codex owns runtime adoption/status/tool exposure.

### External Skill

Third party owns repository/content. FLORAL owns curated package lifecycle metadata and validated checkout management. Codex owns Skill runtime discovery.

### Codex Apps

Codex/OpenAI App ecosystem owns directory, installation, authentication/grants, and callable runtime semantics. FLORAL only provides read-only discovery plus supported user-mediated installation handoff and verification.

### Plugins

Plugin write RPCs remain outside the FLORAL production contract. Phase 8E does not expose an alternate shell/config installation route.

## Diagnostics integration

`floral.extension_control` participates in Self-Diagnostics.

- failed transaction → evidence-backed warning;
- degraded verification → warning;
- prerequisite-required verification → informational diagnostic;
- pending verification/user action → expected control state, not automatically a fault.

Diagnostic findings remain derived hypotheses and do not become authoritative extension state.

## Phase 8D.1 regression fixes included

This patch also closes three test regressions discovered during Phase 8D.1 verification:

1. `maintenance_enabled` now describes availability of the declared governed maintenance contract and no longer incorrectly depends on whether the synthetic test snapshot happened to observe `floral.maintenance`.
2. Configuration inventory test baseline is updated from 71 to 76 environment policies and explicitly checks the five Phase 8D.1 maintenance-autonomy keys.
3. System management-surface test now expects the actual bounded restart executor `system-maintenance/service-restart-worker` instead of the obsolete `scripts/service.ts` metadata.

These are contract/test synchronization fixes; they do not weaken Phase 8D/8D.1 runtime boundaries.

## Closure criteria

Phase 8E may close when all of the following pass:

1. `typecheck`, full Vitest suite, and production build pass on the supported development host.
2. `/system` shows `floral.extension_control` and all observers succeed.
3. A plan-only request calls `plan_extension` and performs no mutation/approval.
4. An exact curated MCP or External Skill action follows plan → one-shot approval → controlled manager.
5. The mutation reply says verification pending and does not perform same-turn shell/config verification.
6. A fresh turn `verify_extension` reaches `verified` when registry/runtime evidence agrees.
7. Missing credential produces `prerequisite-required`, not reinstall loops.
8. App installation remains user-mediated and directory visibility is never promoted to installed/callable state.
9. Unsupported Plugin/arbitrary package requests are refused rather than routed through shell or package managers.
