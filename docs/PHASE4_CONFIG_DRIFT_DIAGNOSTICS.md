# Phase 4.0D — Configuration Drift and Runtime Diagnostics

Phase 4.0D adds a read-only diagnostic layer over the configuration federation.
It does not switch the production service to the Phase 4.0C renderers.

## Five configuration layers

FLORAL now reports five distinct states:

1. **requested** — the non-secret values requested by `config/floral.toml`;
2. **effective** — requested values after explicit environment overrides and locked-policy validation;
3. **rendered** — the deterministic Codex, SearXNG, QQ SDK, and MCP native artifacts;
4. **installed** — the private native bundle, the current managed Codex config, checked-in SearXNG deployment files, and installed QQ SDK version;
5. **observed** — the Codex version and bounded SearXNG `/config` engine/plugin/category surface visible at runtime.

These layers are deliberately separate. A rendered artifact can be correct while the
production service still uses a legacy generator, and an installed SearXNG template
can be correct while upstream inherited defaults change at runtime.

## Compatibility catalog

Reviewed runtime versions are frozen in:

```text
config/catalog/runtime-compatibility.json
```

The initial catalog validates:

- Codex CLI `0.146.1`;
- `@tencent-connect/qqbot-nodejs` `1.0.4`;
- the pinned SearXNG image digest already used by the repository.

An unknown installed version is reported as unvalidated. Updating the catalog is a
review action, not an automatic consequence of upgrading a package or executable.

## Commands

Show a compact diagnostic report:

```bash
corepack pnpm config:diagnostics
```

Show redacted JSON:

```bash
corepack pnpm config:diagnostics:json
```

Check source and installed-configuration structural drift:

```bash
corepack pnpm config:diagnostics:check
```

Runtime availability warnings do not make this command fail, so the source check can
also run on Windows. Use the cutover gate for strict production readiness.

Write a private report to `data/config/diagnostics/latest.json`:

```bash
corepack pnpm config:diagnostics:write
```

The directory is mode `0700` and the report is mode `0600` on POSIX systems. Raw
SearXNG configuration, API keys, QQ credentials, bridge tokens, and prompt/session
content are never written.

Explain one configuration leaf and its provenance:

```bash
corepack pnpm config:explain -- codex.native.reasoning_effort
corepack pnpm config:explain -- deepseek.reasoning_effort
```

The explanation includes requested/effective values, source, environment key,
classification, lock state, and affected rendered artifacts.

## Controlled production cutover gate

```bash
corepack pnpm config:cutover:check
```

Exit code `0` means every cutover blocker is resolved. Exit code `2` means the
configuration system is healthy but production adoption is not ready.

Phase 4.0D intentionally detects the current legacy managed Codex generator as a
cutover blocker. The existing service remains supported; the blocker says only that
Phase 4.0C's renderer has not yet become the production authority.

The initial gate requires:

- the private native bundle and every active artifact match the current renderer;
- checked-in SearXNG compose/settings files match the renderer;
- the configured SearXNG image is reviewed;
- real Codex uses a reviewed version and its installed `config.toml` matches the unified renderer after dynamic bridge URL normalization;
- real QQ mode observes the expected SDK version;
- SearXNG `/config` is available and exposes an effective engine surface when inherited defaults are enabled.

Preview-only artifacts such as `requirements.toml` do not block the gate until a later
administrator-policy adoption phase explicitly installs them.

## SearXNG runtime evidence boundary

The `/config` observer records only:

- top-level key names;
- bounded, sorted engine names;
- bounded, sorted plugin names;
- bounded, sorted category names;
- a fingerprint of that reduced structure.

It does not retain the raw response. This prevents server secrets and unrelated
runtime data from entering diagnostic artifacts.

## Current production behavior

Phase 4.0D is observational. It does not change:

- LaunchAgent installation;
- managed Codex startup;
- DeepSeek bridge behavior;
- QQ transport;
- SearXNG container preparation;
- MCP exposure;
- sandbox or approval policy.

A later controlled adoption phase must consume the cutover gate before replacing the
legacy production generators.
