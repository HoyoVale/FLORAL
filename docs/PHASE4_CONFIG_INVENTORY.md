# Phase 4.0A — Upstream configuration inventory

Phase 4.0A records configuration surfaces before FLORAL introduces a unified
configuration authority. It is intentionally diagnostic: it does not change the
production service, generated Codex config, SearXNG settings, QQ transport, MCP
tool exposure, sandbox, or approval behavior.

## Why this phase exists

FLORAL currently has three kinds of configuration:

1. explicit environment keys parsed by `src/config/env.ts`;
2. hardcoded decisions inside adapters and generated files;
3. upstream defaults and capabilities that are not represented in FLORAL yet.

Only centralizing the first group would hide drift. For example:

- Codex has native model/provider, sandbox, approval, MCP, project, shell,
  history, hook, feature, networking, and diagnostics surfaces;
- SearXNG merges `settings.yml` with upstream defaults when
  `use_default_settings` is enabled;
- the QQ SDK configuration and protocol surface is defined by the exact
  installed package declarations, not by FLORAL's current wrapper alone;
- each MCP has both client-launch configuration and server-specific business
  configuration;
- Peekaboo and MiMo are planned components whose version-specific contracts
  must be frozen before enabling them.

Phase 4.0A therefore establishes an auditable inventory without claiming that
all upstream settings are safe or supported.

## Catalog ownership classes

`config/catalog/upstream-config-catalog.json` classifies every recorded surface:

| Class | Meaning |
|---|---|
| `floral-owned` | Defined and enforced by FLORAL. |
| `upstream-managed` | Native upstream option represented through a typed FLORAL adapter. |
| `upstream-passthrough` | Potential advanced native option; not enabled until version/schema checks and locked-key filtering exist. |
| `observed-only` | Runtime/platform fact that FLORAL may report but should not invent or overwrite. |
| `locked` | Security boundary that configuration must not weaken. |

The catalog currently covers:

- FLORAL gateway and policy;
- Codex CLI/app-server;
- DeepSeek API;
- SearXNG container and `settings.yml`;
- Tencent QQ Bot Node.js SDK;
- optional Better Auth integration;
- MCP client/server boundaries;
- planned Peekaboo integration;
- planned MiMo vision integration.

## Commands

### Human-readable inventory

```bash
corepack pnpm config:inventory
```

The command reports counts, component IDs, detected versions, image digest,
issues, and source/runtime fingerprints. Secret values are never included.

### Strict source/catalog check

```bash
corepack pnpm config:inventory:check
```

This fails only on source/catalog drift, such as:

- an environment key missing from `.env.example`;
- an example key not parsed by `src/config/env.ts`;
- a frozen hardcoded decision no longer matching its source evidence;
- an unpinned SearXNG image;
- malformed or duplicate catalog entries.

Missing local Codex, Peekaboo, or installed QQ SDK declarations are warnings so
Windows and clean CI environments remain supported.

### Private full JSON snapshot

```bash
corepack pnpm config:inventory:write
```

This writes:

```text
data/config/inventory/latest.json
```

The directory is `0700`, the file is `0600`, and the write uses a temporary file
plus atomic rename. The path is ignored by Git.

Use `--json` for JSON on stdout and `--no-runtime` for a deterministic
source-only inventory:

```bash
corepack pnpm config:inventory -- --json --no-runtime
```

## What is observed

### Explicit FLORAL environment

The inventory extracts key names from both:

```text
src/config/env.ts
.env.example
```

It compares the two sets, requires every current key to have an exact component and ownership classification, and records only secret **key names**, never values. The initial catalog classifies all 57 current environment keys.

### Hardcoded decisions

The catalog freezes source evidence for current decisions including:

- Codex reasoning effort, web search, provider retry ownership, MCP tool
  allowlist, approval and read-only sandbox;
- DeepSeek streaming behavior;
- SearXNG inherited defaults, safety, privacy, HTTP method, image digest, and
  loopback binding;
- QQ SDK version and redacted logger;
- the current Peekaboo version-only readiness check.

If the source changes, `config:inventory:check` forces the catalog to be reviewed
rather than silently becoming stale.

### Runtime observations

When available, the command observes:

- `codex --version`;
- `peekaboo --version`;
- installed `@tencent-connect/qqbot-nodejs` package version;
- QQ SDK declaration-file count, exported symbols, and config-like type names.

The QQ SDK is inspected from the installed package files without importing or
starting the SDK.

## Fingerprints

Two fingerprints are emitted:

```text
sourceFingerprint
runtimeFingerprint
```

`sourceFingerprint` covers the catalog, repository dependency versions,
explicit key inventory, hardcoded evidence, SearXNG image, and settings surface.
It is stable across timestamps.

`runtimeFingerprint` additionally covers local component observations. Later
Phase 4.0 stages will distinguish requested and effective configuration using
these foundations.

## Non-goals

Phase 4.0A does **not**:

- create `config/floral.toml`;
- change `.env` semantics;
- alter generated `CODEX_HOME/config.toml`;
- enable native passthrough;
- change SearXNG engines or plugins;
- expose new QQ SDK capabilities;
- enable Peekaboo or MiMo;
- change sandbox, tool, MCP, or approval permissions.

Those changes belong to Phase 4.0B–4.0D after this inventory is reviewed and
stable.

## Next stages

```text
Phase 4.0A  inventory and capability catalog
Phase 4.0B  configuration federation core
Phase 4.0C  versioned native adapters and renderers
Phase 4.0D  effective configuration, drift, explain, and compatibility tools
Phase 4P    capability authorization and QQ approval authority
Phase 4V    Peekaboo capture plus MiMo read-only vision
```
