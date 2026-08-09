# Phase 8A.5 — Read-Only System Interface

Status: implementation candidate

## Purpose

Phase 8A.1–8A.4 established the machine-readable System Awareness foundation:
`SystemDefinition`, `SystemEvidence`, `SystemSnapshot`, management-contract metadata,
observers, and snapshot resolution semantics.

Phase 8A.5 exposes that foundation to the Agent and to the chat owner without
adding any self-maintenance capability.

The central invariant is:

> FLORAL may describe what an action would require without gaining permission to
> perform that action.

`unknown` and `conflict` remain first-class states. Neither the Agent nor the
read interface may upgrade them through guesses, shell inspection, or unrelated
configuration data.

## Client-hosted `floral_system`

System Awareness is exposed to Codex as a client-hosted dynamic namespace, not
as another MCP subprocess:

- `floral_system/system_summary`
- `floral_system/component_status`
- `floral_system/capabilities`

This is intentional. The System Snapshot needs access to FLORAL-owned process
state and supported Codex runtime RPCs. A separate MCP subprocess would either
lose that in-process authority or require a second privileged control channel.

### Per-turn snapshot rule

Before `turn/start`, `CodexAppServerRuntime` asks the configured System Awareness
provider for a fresh snapshot and caches it under the thread ID. Dynamic tool
handlers during that turn read only this frozen snapshot.

They do not call Codex RPCs from inside `item/tool/call` handling. This avoids a
nested-RPC / reentrancy dependency and guarantees that all System Awareness
answers within one turn refer to the same observation boundary.

The cache is deleted when the turn finishes, when the thread is archived, and
when the runtime stops.

Dynamic tool registration is a `thread/start` surface. FLORAL therefore appends
the `floral_system` developer guidance only when creating a new thread with the
current tool registry. A thread created before Phase 8A.5 can retain its older
persisted dynamic-tool metadata when it is resumed; `/new` is the deterministic
activation path after an upgrade. `/system` remains available independently at
the Gateway layer.

Snapshot collection is fail-soft. If collection fails, the Agent turn may
continue, but `floral_system` reports the snapshot as unavailable rather than
inventing state.

## Tool semantics

### `system_summary`

Returns a bounded summary containing:

- definition fingerprint and snapshot time;
- declared component count;
- observed component count;
- resolved / unknown / conflicting fact counts;
- observer health and evidence counts;
- one bounded status line per component.

### `component_status`

Requires a declared component ID and returns:

- owner and authority;
- failure domain and parent component;
- declared state facts;
- resolution and confidence for each fact;
- bounded evidence provenance (`source`, `kind`, `scope`, `observed_at`);
- secret dependency names only, never secret values.

Facts declared by a `SystemDefinition` but absent from the current snapshot are
materialized as explicit `unknown` facts.

### `capabilities`

Returns declared `ManagementActionDefinition` metadata:

- disposition;
- approval requirement;
- capability name, if any;
- intended executor;
- intended verification source.

Every response explicitly states:

- `read_only=true`;
- `authorization_granted=false`;
- `execution_performed=false`.

No action described by this tool is executable through `floral_system` in Phase
8A.5.

## Human `/system` command

The Gateway also exposes:

- `/system`
- `/system <component-id>`

The command builds a fresh read model for the selected project/Codex thread and
uses the same formatters as the Agent dynamic tools. It does not start an Agent
turn and does not provide a mutation path.

Audit events store only bounded command metadata (component ID, component count,
observer failure count, error type). They do not persist the full snapshot or
secret material.

## Production wiring

`main.ts` creates one Gateway-facing `SystemAwarenessReader` around the managed
Agent runtime.

For the inner `CodexAppServerRuntime`, `ManagedCodexDeepSeekRuntime` constructs a
reader whose Codex runtime observer points at that inner runtime itself. This is
important: routing the inner snapshot through the outer managed runtime would
create an ownership loop back into runtime-slot creation.

The inner reader is lazy and the snapshot is captured before the turn.

## Security boundary

Phase 8A.5 does **not** add:

- service restart tools;
- config mutation;
- shell or filesystem bypasses;
- MCP / Skill / App lifecycle privileges beyond existing Phase 7 surfaces;
- approval shortcuts;
- Plugin installation;
- autonomous repair.

`ManagementActionDefinition` remains descriptive policy metadata only.

## Acceptance checks

Windows baseline must pass:

```powershell
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

Runtime checks:

```text
/system
/system codex.apps
```

Agent checks should cause Codex to use `floral_system` when appropriate, for
example:

```text
检查你现在拥有哪些系统组件，哪些状态是 unknown，并说明证据来自哪里。
```

The Agent must preserve `unknown` / `conflict`, and `capabilities` must never be
interpreted as authorization to perform the described action.
