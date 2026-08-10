# Phase 8D.1 — Maintenance Autonomy Policy

Status: implementation candidate for Windows + Mac acceptance.

## Goal

Phase 8D proved that FLORAL can perform one bounded host lifecycle action (`floral.service/restart`) through a governed controller, Mac-local confirmation, post-reply handoff, and fresh-instance verification.

Phase 8D.1 adds an explicit autonomy policy so the owner can decide how much of that already-bounded action may run without per-action local confirmation. It does **not** add generic shell execution, arbitrary LaunchAgent control, arbitrary repair plans, or model-owned privilege escalation.

The security invariant is:

> The model may request a declared maintenance action, but only the host can classify the trigger, apply the machine-local autonomy ceiling, enforce rate/cooldown/circuit-breaker policy, and execute the fixed worker.

## Modes

### `manual`

Default and safest mode.

- Every `system.restart` continues to require Mac-local confirmation.
- This preserves Phase 8D behavior.
- Upgrade default is `manual`, even if an older state file exists above a newly lowered machine ceiling.

### `owner-auto`

Allows one narrow class of owner-requested maintenance to skip per-action local confirmation.

The host must independently recognize the **original owner message** as a direct FLORAL restart imperative, for example:

- `请重启`
- `请重启 FLORAL`
- `restart floral`

Negated, conditional, or indirect text is not eligible, for example:

- `不要重启`
- `如果坏了就重启`
- `诊断一下，必要时重启`

The model cannot set `trigger=owner-auto`; that trigger is assigned only by Gateway state after the host-side intent check and AuthorizationAuthority path complete.

### `self-heal`

Includes `owner-auto` behavior and enables a host supervisor to run deterministic repair rules without a new user message.

Self-Heal v1 is deliberately narrow. The only automatic repair currently eligible is:

```
high-confidence built-in FLORAL MCP runtime finding
  status = failed | cancelled
  component = mcp.floral_*
        ↓
floral.service/restart
```

The following do **not** trigger Self-Heal v1:

- `starting`
- `unknown`
- `ready-without-tools`
- external MCP failures
- network/provider speculation
- low/medium-confidence findings
- model-written repair suggestions
- arbitrary shell/process checks

## Machine-local ceiling

The current mode can never exceed:

```text
FLORAL_MAINTENANCE_MODE_CEILING
```

Allowed values:

```text
manual
owner-auto
self-heal
```

Default:

```text
manual
```

The ceiling is intentionally machine-local. It is:

- parsed only by the FLORAL parent process;
- classified as locked/machine policy;
- stripped from the Codex child environment together with the other maintenance policy variables;
- not writable through project config;
- not mutable through `floral_system`;
- not raisable by the model.

Lowering the machine ceiling clamps the persisted requested mode downward during controller initialization. Raising the ceiling later does not silently restore a previously higher requested mode; the owner must explicitly opt in again with `/maintenance`.

## Runtime mode command

Owner-facing commands:

```text
/maintenance
/maintenance manual
/maintenance owner-auto
/maintenance self-heal
/maintenance reset-breaker
```

`/maintenance` reports:

- requested mode;
- effective mode;
- machine ceiling;
- allowlisted actions;
- automatic actions in the last hour;
- cooldown;
- Self-Heal interval;
- consecutive Self-Heal failures;
- circuit-breaker state.

A remote owner command may select a mode only **within** the already-local machine ceiling. It cannot raise the ceiling itself.

## Rate limit and cooldown

All automatically approved actions (`owner-auto` and `self-heal`) share the same bounded automatic-action budget:

```text
FLORAL_MAINTENANCE_MAX_ACTIONS_PER_HOUR=2
FLORAL_MAINTENANCE_COOLDOWN_MS=300000
```

The controller, not the model, records automatic action timestamps in the machine-private maintenance state.

This prevents rapid repeated restarts even when the user or diagnostic loop repeats the same request.

## Circuit breaker

Self-Heal has a separate consecutive repair-failure counter:

```text
FLORAL_MAINTENANCE_FAILURE_THRESHOLD=2
```

A critical semantic distinction is enforced:

> `restart verified` does not mean `target fault repaired`.

After the new FLORAL instance starts, the supervisor obtains a fresh System Awareness model and compares the original evidence-backed finding IDs with the new diagnostic findings.

Outcomes:

```text
restart action failed
→ repair_outcome=action-failed
→ failure counter +1

restart verified + original finding still present
→ repair_outcome=persistent
→ failure counter +1

restart verified + original finding disappeared
→ repair_outcome=resolved
→ failure counter reset to 0
```

When the failure threshold is reached:

```text
circuit_breaker=open
```

Further `self-heal` actions stop automatically. Manual/owner-governed paths remain separately available. The owner may inspect the evidence and then explicitly run:

```text
/maintenance reset-breaker
```

## Self-Heal scheduling

The host supervisor runs after a startup grace period and then at:

```text
FLORAL_MAINTENANCE_SELF_HEAL_INTERVAL_MS=60000
```

Each pass first reads the local autonomy/receipt state. In `manual` and `owner-auto`, it does **not** poll Codex/System Awareness merely because the timer fired. A fresh System Awareness model is read only when a verified previous Self-Heal must be reconciled or when `self-heal` is currently eligible to evaluate repair rules. The active path is:

1. read local autonomy/receipt state;
2. if needed, read one fresh System Awareness model and build deterministic diagnostics;
3. reconcile the previous verified Self-Heal transaction against current finding IDs;
4. notify the owner of the final repair outcome when possible;
5. re-read current autonomy/circuit-breaker state;
6. enforce mode, allowlist, hourly limit, and cooldown;
7. select only a built-in deterministic repair rule;
8. queue and execute the fixed maintenance worker.

This order prevents a successful LaunchAgent restart from being falsely counted as a successful repair when the original component failure persists.

## Owner notification

FLORAL remembers the most recent owner delivery conversation only in the private maintenance state so a later host-triggered Self-Heal can report its result.

System Awareness exposes only:

```text
owner_notification_target_present=true|false
```

It does not expose the raw conversation identifier.

Notifications distinguish:

- action verified **and** fault resolved;
- action verified but fault persistent;
- maintenance action failed.

They also report whether the circuit breaker opened.

## System Awareness

`floral.maintenance` now exposes three authoritative machine facts:

```text
last_transaction
autonomy_policy
autonomy_state
```

`last_transaction` may include:

```text
trigger
 diagnostic_finding_ids
 notification_status
 repair_outcome
```

`autonomy_policy` includes the mode/ceiling/limits. `autonomy_state` includes counters and circuit-breaker state without revealing the owner conversation identifier.

The `floral.service/restart` management contract now declares:

```text
approval=autonomy-policy
```

because approval is no longer always Mac-local: it is conditionally resolved by the host policy. The underlying `system.restart` capability remains a local-confirmation capability when the autonomy policy does not independently pre-authorize the exact bounded case.

## Diagnostics semantic fix

Phase 8D had a user-visible inconsistency: `/diagnose` could print `maintenance_enabled=false` even though `floral_system/maintain` was working.

Phase 8D.1 derives `maintenance_enabled` from the observed `floral.maintenance` component plus the declared `floral.service/restart` contract. In a normal LaunchAgent deployment with the maintenance observer present, it should now report:

```text
maintenance_enabled=true
```

An open Self-Heal circuit breaker is itself an evidence-backed warning finding under `floral.maintenance`.

## Non-goals / hard boundaries

Phase 8D.1 does not provide:

- generic automatic approval;
- generic `system.restart` for arbitrary components;
- model-selected executables or command arguments;
- shell/launchctl fallback;
- arbitrary repair-rule creation by the model;
- Agent mutation of the machine autonomy ceiling;
- automatic external MCP/App/Skill installation;
- automatic secret provisioning;
- automatic network/provider remediation.

Those boundaries are prerequisites for safely reusing the same autonomy framework in later controlled self-extension work.

## Suggested acceptance

### Windows release gate

```powershell
git apply --check .\FLORAL-Phase8D.1-maintenance-autonomy-policy.patch
git apply .\FLORAL-Phase8D.1-maintenance-autonomy-policy.patch
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

### Mac — default safety check

Without changing `.env`:

```text
/maintenance
```

Expected effective/ceiling mode: `manual`. A direct restart still requires Mac-local confirmation.

### Mac — owner-auto acceptance

Set locally:

```text
FLORAL_MAINTENANCE_MODE_CEILING=owner-auto
```

Restart FLORAL once, then:

```text
/maintenance owner-auto
/maintenance
```

Send the direct owner message:

```text
请重启
```

Expected:

- no per-action Mac-local confirmation prompt;
- Agent still uses `floral_system/maintain` rather than shell;
- post-reply handoff occurs;
- next instance writes a verified maintenance receipt;
- `trigger=owner-auto`.

A conditional request such as `如果坏了就重启` must **not** receive owner-auto approval.

### Mac — Self-Heal policy acceptance

Set locally:

```text
FLORAL_MAINTENANCE_MODE_CEILING=self-heal
```

Restart once, then:

```text
/maintenance self-heal
/system floral.maintenance
```

Do not intentionally break production merely to prove automation. A controlled fault-injection test should be a separate explicit acceptance step because Self-Heal is designed to restart the live FLORAL service.
