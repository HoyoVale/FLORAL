# Phase 8D — Controlled Self-Maintenance

Phase 8D gives FLORAL its first executable self-management action without granting a general-purpose maintenance shell.

The control loop is deliberately narrow:

```text
evidence-backed diagnosis
        ↓
declared management action
        ↓
capability / approval contract
        ↓
Mac-local confirmation
        ↓
bounded host executor
        ↓
post-action verification receipt
```

## 1. Phase 8C prompt-routing regression closed

A real Phase 8C acceptance run showed a diagnosis-only request reaching for an ad-hoc `ls` of `.floral/` before answering. The command was still protected by normal shell approval, so the security boundary held, but the routing behavior was wrong: System Awareness already had an evidence-backed diagnosis surface and the user explicitly requested diagnosis without repair.

Phase 8D therefore strengthens the System Awareness developer policy:

- `floral_system/diagnose` is the primary/first tool for broad FLORAL diagnosis.
- A healthy diagnostic result is sufficient unless the owner explicitly asks for an independent host-level investigation.
- Diagnosis-only / inspect-only / no-change requests must not call `floral_system/maintain` or request mutation approval.
- Read-only checks returned by diagnostics are recommendations, not automatic permission to run shell commands.
- `.floral/*`, arbitrary repository files, process tables, shell output, and network probes are not substitutes for the System Awareness authority surface.
- A resumed system-aware thread receives the same System Awareness routing policy through `thread/resume`; a legacy thread without the current tool surface must ask for `/new` rather than imitate the missing control plane with shell probing.

This is a routing fix, not a reduction of ordinary Codex shell capability. Shell remains available for user-requested work under the existing sandbox and approval rules; it simply is not the fallback authority for FLORAL self-diagnosis.

## 2. New governed maintenance tool

`floral_system` now exposes:

```text
maintain
```

Phase 8D intentionally supports exactly one executable management action:

```text
component = floral.service
action    = restart
capability = system.restart
approval   = local-confirmation
```

The host validates this against `SystemDefinitionRegistry`. The model cannot provide an arbitrary executable, launchd target, command line, path, capability, or verification method.

Before an approval request is emitted, the host independently derives a diagnostic preflight for `floral.service`. The preflight status and finding count are included in the approval summary and queued result. This keeps the pipeline evidence-linked even if the model has already performed its own diagnostic call. A healthy preflight does not silently veto an explicit owner-requested restart; the Mac-local confirmation remains the final authority for this bounded action.

## 3. No remote/session authorization for service restart

`system.restart` remains a `local-confirmation` capability.

A chat-side owner can request the action, but cannot approve the host lifecycle mutation remotely. The existing `LocalConfirmationBroker` must receive an approval on the Mac. Session approval is not supported for `system-maintenance`.

This means Phase 8D does **not** turn `/approve-session` into a persistent restart permission.

## 4. Why restart is queued instead of executed in the tool call

FLORAL cannot safely synchronously replace its own LaunchAgent process while the Agent turn is still producing and delivering the answer. Doing so could destroy the initiating response halfway through delivery and leave the user unsure whether anything happened.

The execution lifecycle is therefore:

1. `floral_system/maintain` validates the declared action.
2. Mac-local confirmation succeeds.
3. `SystemMaintenanceController.prepare()` writes an `approved-queued` transaction receipt.
4. The dynamic tool returns `system_maintenance=queued` with `execution_performed=false`.
5. The Agent finishes its final reply.
6. Only after final reply delivery succeeds does Gateway hand the transaction to the fixed detached restart worker.
7. The worker waits briefly, invokes the fixed LaunchAgent restart target, waits for a new ready PID, and writes `verified` or `failed`.

If the Agent run or final reply delivery fails before handoff, Gateway marks the queued transaction `cancelled` and does not execute it. A maintenance action therefore cannot silently execute before the owner receives the initiating result, and a stale queued receipt cannot permanently block later maintenance.

## 5. Bounded restart worker

The detached worker is not a generic shell executor.

It accepts only host-generated arguments identifying:

- the private maintenance receipt directory;
- one validated transaction id;
- the FLORAL service-state path.

For the actual restart it invokes only:

```text
/bin/launchctl kickstart -k gui/<uid>/<FLORAL fixed LaunchAgent label>
```

The model cannot change the executable, launchd label, or arguments. The worker receives a deliberately minimal environment and does not inherit FLORAL's provider/API credential environment.

Only one active `approved-queued` / `handoff` / `running` restart transaction may exist at a time. Duplicate restart requests are rejected until the prior transaction reaches `verified` or `failed`.

## 6. Verification is a fresh-turn fact

The worker does not call a restart successful merely because `launchctl` returned zero. It polls FLORAL's service state and requires:

```text
phase = ready
pid != previous_pid
new pid is alive
```

Only then is the transaction marked:

```text
status = verified
verification = service-ready-new-pid
```

The latest bounded transaction is observed as the new System Awareness component:

```text
floral.maintenance
  fact = last_transaction
  source = maintenance-receipt
  confidence = authoritative
```

Because the initiating Agent turn uses a frozen pre-turn snapshot, it must not claim that the restart succeeded. Verification belongs to a fresh turn or owner-facing `/system floral.maintenance` after the service returns.

The persisted receipt contains bounded lifecycle metadata only. The model-provided rationale is used for the approval request but is not persisted into the maintenance transaction, reducing the chance that accidental sensitive text becomes lifecycle state.

## 7. Diagnostics remain non-mutating

`/diagnose` and `floral_system/diagnose` remain non-mutating:

```text
execution_performed=false
```

At the original Phase 8D closure the formatter also emitted `maintenance_enabled=false` to mean that diagnostics themselves did not mutate state. **Phase 8D.1 superseded that overloaded meaning:** current reports emit `maintenance_enabled=true` when the separately governed `floral_system/maintain` surface is declared/available, while `execution_performed=false` remains the authoritative statement that this diagnostic call performed no maintenance.

If a maintenance receipt ends in `failed`, Phase 8C diagnostics can surface a degraded `floral.maintenance.last-transaction-failed` finding without attempting another restart.

## 8. Explicitly out of scope

Phase 8D does not add:

- generic shell-based self-repair;
- arbitrary `launchctl` execution;
- configuration writes;
- package installation;
- automatic MCP repair;
- automatic service restart from a diagnosis finding;
- remote approval for `system.restart`;
- session-wide maintenance authorization;
- same-turn post-restart success claims.

Those capabilities must each receive their own declared action, authority, bounded executor, approval policy, and verifier before they can become executable.

## 9. Acceptance checks

### Diagnosis routing regression

Start a fresh thread and ask only for diagnosis, explicitly forbidding repair. The Agent should use `floral_system/diagnose`; it should not request shell approval merely to list `.floral/`, inspect processes, or probe the network.

### Controlled restart

Only when intentionally testing a restart, ask FLORAL to use the governed maintenance interface. Expected lifecycle:

```text
request
→ Mac-local system.restart confirmation
→ tool result: queued / execution_performed=false
→ Agent final reply delivered
→ detached fixed worker handoff
→ LaunchAgent replacement
→ fresh service becomes ready
→ /system floral.maintenance shows verified + new PID
```

A denied local confirmation must result in no transaction execution. A duplicate active transaction must not queue a second restart. A run that fails after approval but before handoff must leave a `cancelled` receipt rather than an indefinitely queued restart.
