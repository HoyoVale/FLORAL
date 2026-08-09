# Phase 8A — System Awareness Foundation

Phase 8A introduces the read-only data model that FLORAL will use to describe itself before any self-maintenance authority is added.

## Scope

This phase implements **8A.1–8A.4 only**:

1. `SystemDefinition`, `SystemEvidence`, `SystemSnapshot`, and `ManagementActionDefinition`.
2. `SystemDefinitionRegistry` plus the initial architecture census.
3. Read-only observers for configuration, service state/liveness, Codex runtime discovery, and curated external extension registries.
4. `SystemSnapshotBuilder`, including conservative evidence resolution and observer-failure isolation.

It intentionally does **not** add:

- an Agent-facing `floral_system` tool;
- `/system` chat commands;
- service restart/self-repair actions;
- generic config mutation;
- generic shell-based diagnostics;
- new approval bypasses;
- a large static system prompt.

Those surfaces belong to later Phase 8 work after the read-only model has been exercised on the real Mac runtime.

## Core invariants

### Evidence lanes do not collapse

Configuration intent, registry metadata, filesystem records, process observation, and Codex runtime RPC results remain separate evidence sources.

Examples:

- `app/list` directory visibility is not installed/callable evidence.
- an enabled External MCP registry row is not runtime-ready evidence.
- a `service-state.json` phase is not process-liveness evidence.
- a configured MCP tool is not proof that Codex currently advertises the tool.

### `unknown` is a valid state

When an authoritative interface is unavailable, Phase 8A records `confidence=unknown` and `value=null`. It does not fill the gap from weaker evidence.

The App compatibility fallback is the canonical example: if `app/installed` is unsupported and FLORAL falls back to `app/list`, the directory rows are preserved as `directory_fallback`, while `installed` and `callability` remain unknown.

### Ownership is not management authority

Each `SystemDefinition` separately records:

- owner;
- current-state authority;
- management actions FLORAL actually has today;
- approval requirement;
- executor and verification surface where applicable.

A component being known to FLORAL does not imply that FLORAL may mutate it.

### Secrets are presence-only

System definitions contain only secret dependency names. Observers may report whether an environment-backed secret is present, plus the environment variable name, but never the credential value.

### Observer failure is contained

`SystemSnapshotBuilder` runs read-only observers independently. A failed observer contributes an `errorType` to the observer summary but does not abort the entire snapshot or invent state for components it failed to inspect.

## Initial definition census

The default registry currently models 19 components:

- `floral.service`
- `floral.configuration`
- `floral.authorization`
- `floral.workspace`
- `floral.storage`
- `codex.runtime`
- `codex.skills`
- `codex.apps`
- `codex.mcp`
- `codex.plugins`
- `extensions.external_skills`
- `extensions.external_mcp`
- `deepseek.provider`
- `search.searxng`
- `mcp.floral_search`
- `mcp.floral_vision`
- `mcp.floral_peekaboo`
- `transport.feishu`
- `transport.qq`

The registry is source-controlled architecture metadata, not a replacement for runtime evidence.

## Evidence resolution

For one fact within one snapshot, the builder applies a deliberately conservative order:

```text
authoritative > observed > inferred > unknown
```

Before resolving a fact, only the newest observation from each source is considered. If two equally strong sources disagree, resolution becomes:

```text
resolution = conflict
confidence = unknown
value = null
```

The full evidence set remains attached to the fact so later diagnostics can explain the conflict.

## Read-only observers

### ConfigurationSystemObserver

Reads an already-resolved `ConfigurationAuthority` plus validated machine-local environment policy and emits only bounded metadata:

- profile/fingerprints;
- environment override names;
- locked paths;
- secret presence records;
- authorization configuration;
- machine-local remote-mode ceiling and workspace-root presence;
- configured Codex/model/search/transport state;
- FLORAL built-in MCP registry intent.

It never serializes secret values or the full effective configuration object.

### ServiceStateSystemObserver

Keeps persisted service metadata and live process liveness separate:

```text
service-state.json -> recorded.*
process.kill(pid, 0) -> process.alive
```

A missing or malformed service-state record cannot become a claim that the process is stopped.

### CodexRuntimeSystemObserver

Uses supported runtime interfaces only:

- Skill discovery;
- installed Apps;
- App directory;
- native extension feature state;
- MCP server/tool status.

It preserves `directory-fallback` semantics and does not call Plugin write RPCs or extension-management actions.

### ExternalExtensionSystemObserver

Reads the machine-local curated External Skill and External MCP registries. Registry rows describe FLORAL lifecycle metadata only; runtime discoverability/readiness must come from Codex runtime evidence.

GitHub authentication is exposed only as `present=true/false` for `GITHUB_PAT_TOKEN`.

## Snapshot characteristics

A snapshot includes:

- schema version;
- generation time;
- a SHA-256 fingerprint of the definition registry;
- every defined component, including currently unobserved ones;
- resolved facts plus their complete evidence sets;
- observer success/failure summaries.

No snapshot is treated as durable configuration.

## Validation boundary

Phase 8A adds focused regression tests for:

- definition/authority invariants;
- defensive registry copies and stable fingerprints;
- evidence precedence and conflicts;
- first-class unknown semantics;
- observer failure containment;
- App directory-fallback correctness;
- MCP runtime/config separation;
- service-state/process-liveness separation;
- secret non-disclosure.

The implementation is designed so Phase 8A.5 can later expose selected read-only views without changing the underlying authority model.
