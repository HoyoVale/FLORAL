# Phase 4.0E3 — MCP Registry Runtime Adoption

Phase 4.0E3 makes the unified MCP manifest the canonical source for Codex MCP
registration. The active Codex `config.toml` and the private MCP manifest are
now rendered from the same typed registry instead of duplicating search MCP
logic in two adapters.

## Scope

This phase adopts only the MCP registration projection that is embedded in the
already-unified Codex configuration. It does not enable the planned MiMo Vision
or Peekaboo MCP adapters, change QQ SDK construction, or change SearXNG
container preparation.

The registry contains:

- server ID and integration state;
- stdio command, arguments, and explicitly allowed environment entries;
- parent-environment inheritance policy;
- startup and tool timeouts;
- required-server policy;
- enabled tool allowlists;
- server-level and per-tool approval metadata;
- a deterministic registry fingerprint.

Planned adapters remain disabled and fail closed if configuration attempts to
enable them before an active transport adapter exists.

## Runtime adoption

When `runtime.adoption.codex.mode = "unified"`:

1. FLORAL builds the canonical MCP registry.
2. The Codex renderer projects active registry entries into `mcp_servers.*`.
3. Codex starts with the unified configuration.
4. FLORAL verifies that the installed Codex MCP assignment projection matches
   the registry projection.
5. A private tamper-evident adoption report is written to
   `data/config/adoption/mcp-registry.json`.
6. A report failure is treated as a unified-start failure and triggers the
   existing one-shot legacy rollback path.

The legacy Codex generator remains available only as the emergency rollback
configuration. It is not the source of truth for the adopted registry.

## Commands

```bash
corepack pnpm config:mcp-adoption
corepack pnpm config:mcp-adoption:json
corepack pnpm config:mcp-adoption:check
```

`config:mcp-adoption:check` returns exit code `0` only when unified Codex mode
is active and the current registry, Codex MCP projection, and adoption report
agree. It returns `2` for a missing, invalid, or stale report.

## Security properties

- Parent environment inheritance remains forbidden.
- Only explicit environment entries are rendered.
- Secret values are not stored in the registry or adoption report.
- Planned adapters cannot be enabled accidentally.
- Duplicate server IDs, tool names, and environment keys are rejected.
- The report stores only fingerprints, server IDs, and tool allowlists.
- Report files use private permissions and atomic replacement.

## Acceptance

A complete Mac validation should report:

```text
config.mcp_adoption.status=active
config.mcp_adoption.current_status=active
config.diagnostics.mcp_registry=active
config.cutover.status=ready
```

The service must remain `ready`, the Codex controlled cutover must remain
`active`, and the QQ full chain plus SearXNG tool path must continue to work.
