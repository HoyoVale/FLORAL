# Phase 8C — Self-Diagnostics

## Scope

Phase 8C turns the Phase 8A/8B evidence graph into a deterministic, read-only diagnostic layer.

It answers a narrower question than System Awareness:

> Given the facts FLORAL can currently prove, what is unhealthy or uncertain, which failure domains are most plausible, and what read-only checks should happen next?

Phase 8C does **not** enable self-maintenance. It adds no restart, install, enable, disable, remove, configuration write, shell bypass, or authorization grant.

## Bug fix carried with this phase

Phase 8B generalized the GUI mutation routing prose and accidentally removed the literal `floral_peekaboo/click` token that the existing Codex App Server regression fixture uses to verify the long-lived FLORAL routing contract. Three tests therefore failed before reaching their intended scenarios.

Phase 8C restores the explicit governed route in a state-safe form:

```text
floral_peekaboo/click when it is currently available
```

The sentence still requires runtime availability to be checked through `floral_system`; it does not turn the tool name into a static availability claim.

## Diagnostic model

New module:

```text
src/system-awareness/system-diagnostics.ts
```

Diagnostics are derived from an already captured `SystemReadModel`.

A diagnostic finding contains:

- component / optional subject;
- severity and status;
- overall impact;
- diagnostic confidence;
- ordered candidate failure domains;
- references to supporting facts and evidence source ids;
- an ordered read-only check plan;
- explicit limitations.

Derived diagnostic findings are deliberately **not** added back into `SystemSnapshot` as evidence. This prevents a reasoning loop where an inference could later masquerade as an authoritative observation.

## Diagnostic semantics

The formatter freezes the following contracts into every report:

```text
diagnostic_semantics=derived-findings-are-not-authoritative-state-evidence
causality_semantics=candidate-failure-domains-are-ranked-hypotheses-not-proven-root-cause
unknown_semantics=absence-of-evidence-must-not-be-upgraded-by-guessing
recommendation_semantics=checks-are-read-only-plans-and-are-not-executed-by-this-interface
management_semantics=use-floral_system-capabilities-separately-before-discussing-any-governed-repair-action
```

Every report also carries:

```text
execution_performed=false
maintenance_enabled=false
```

## First deterministic rule set

### Observer failures

A failed System Awareness observer produces an observability-degraded finding. The diagnostic layer only records the bounded observer error type already present in the snapshot; it does not expose raw exception text.

### Evidence conflicts

Any `resolution=conflict` becomes an explicit conflict finding. Equal-strength disagreement is never automatically resolved by source name or heuristic preference.

### FLORAL service

The first service rule distinguishes persisted lifecycle state from process liveness:

```text
recorded.phase=ready
process.alive=false
```

This yields a high-confidence unavailable diagnosis pointing first to the host/service boundary. It does not restart LaunchAgent.

### Built-in FLORAL MCP

For `mcp.floral_*`:

```text
configured.enabled=true
+
runtime unknown/failed/cancelled/starting/ready
```

are evaluated separately.

A missing required secret is diagnosed before runtime failure attribution. A ready server with no tools is treated as degraded capability rather than healthy readiness.

### Curated External MCP

Phase 8C correlates three existing authoritative lanes:

```text
extensions.external_mcp/packages
extensions.external_mcp/auth_presence
codex.mcp/servers
```

Example:

```text
registry installed=true
registry enabled=true
auth present=true
Codex server absent
```

produces a diagnosis that points first to Codex/FLORAL activation or runtime adoption rather than claiming installation or credential failure.

If required authentication is missing, that prerequisite is diagnosed first and runtime absence is not misclassified as the primary problem.

`ready + tools=[]` is degraded. `starting` is transient/degraded and requires a fresh next-turn snapshot before escalation. `failed`/`cancelled` preserve bounded runtime failure metadata and expose only ranked failure-domain hypotheses.

### Codex Apps fallback

`app/list` fallback remains an informational authority gap:

```text
directory visible
installed=unknown
callability=unknown
```

It does not make overall system health degraded by itself and is never described as proof that an App is broken or absent.

### Provider and selected transport prerequisites

The first rule set also detects:

- missing DeepSeek provider credential presence;
- selected Feishu transport with missing credential presence.

No secret values are read or emitted.

## Agent interface

`floral_system` gains:

```text
diagnose
```

Input:

```json
{}
```

or:

```json
{"component_id":"extensions.external_mcp"}
```

It uses the same pre-turn frozen SystemSnapshot as the other `floral_system` tools. It performs no nested runtime RPC and does not refresh after same-turn mutations.

Developer policy now instructs the model to use `floral_system/diagnose` for evidence-backed fault explanation, while preserving diagnostic confidence and limitations.

## Owner-facing interface

New commands:

```text
/diagnose
/diagnose <component>
```

Like `/system`, these commands read System Awareness directly and do not start an Agent turn.

Examples:

```text
/diagnose floral.service
/diagnose extensions.external_mcp
/diagnose mcp.floral_search
```

## Security boundary

Phase 8C explicitly does not:

- call `service:restart`;
- change `/mode`;
- modify FLORAL or Codex configuration;
- install/remove/enable/disable MCP or Skills;
- use shell to bypass governed extension surfaces;
- inspect secret values;
- convert diagnostic inference into authoritative evidence;
- refresh a frozen snapshot from inside a dynamic tool call.

If a user asks what repair actions exist, the Agent may separately read `floral_system/capabilities` and describe their declared approval contract. That remains metadata, not authorization.

## Release gate

Windows baseline after applying the Phase 8C patch:

```powershell
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

Mac runtime acceptance after pull/restart:

```text
/diagnose
/diagnose floral.service
/diagnose extensions.external_mcp
/new
```

Then ask:

> Diagnose any current FLORAL problems. Separate proven facts from diagnostic hypotheses, rank the likely failure domains, and give only a read-only check plan. Do not repair anything.

Acceptance requires the Agent to call `floral_system/diagnose`, preserve `unknown`/`conflict`, and not execute maintenance.
