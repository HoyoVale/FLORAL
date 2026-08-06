# Phase 4.0E1 — Codex unified configuration shadow adoption

Phase 4.0E1 connects the unified configuration authority to the real managed
Codex startup path without changing the production `config.toml` source.

## Runtime modes

`config/floral.toml` now owns:

```toml
[runtime.adoption.codex]
mode = "unified-shadow"
```

Supported modes are:

- `legacy`: emergency rollback; only the established generator runs.
- `unified-shadow`: the established generator remains authoritative, while the
  unified renderer runs beside it and produces a private semantic comparison.

There is deliberately no `unified` production mode in Phase 4.0E1. Phase
4.0E2 will add it only after the shadow gate is compatible on the Mac service.

## Semantic comparison

The comparison ignores comments and formatting, then compares assignments by
fully qualified TOML path. Three unified-only safety fields are expected:

- `approval_policy`
- `sandbox_mode`
- `model_reasoning_summary`

Any missing legacy assignment, unexpected unified assignment, or differing
shared assignment makes the report `drift`. Values are not persisted in the
report; only assignment paths and SHA-256 fingerprints are recorded.

The report is written atomically to:

```text
data/config/adoption/codex-shadow.json
```

The directory is `0700`, the report is `0600`, and the path is ignored by Git.

## Fail-open behavior

Shadow resolution, rendering, comparison, or report-writing errors are logged
as a shadow error, but the established legacy config still starts Codex. This
is intentional for Phase 4.0E1: diagnostics may fail, but production must not
be replaced or interrupted.

## Commands

After restarting the FLORAL service:

```bash
corepack pnpm config:codex-shadow
corepack pnpm config:codex-shadow:check
corepack pnpm config:diagnostics
corepack pnpm config:cutover:check
```

A successful shadow result contains:

```text
config.codex_shadow.status=compatible
config.diagnostics.codex_shadow=compatible
```

The global cutover gate remains blocked by
`codex-managed-config-legacy-drift`, because Phase 4.0E1 still installs the
legacy config by design.

## Rollback

Set:

```toml
[runtime.adoption.codex]
mode = "legacy"
```

and restart the service. This disables shadow rendering while retaining the
same production generator used before Phase 4.0E1.
