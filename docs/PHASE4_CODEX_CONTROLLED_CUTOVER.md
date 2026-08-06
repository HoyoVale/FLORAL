# Phase 4.0E2 — Codex unified configuration controlled cutover

Phase 4.0E2 activates the deterministic unified Codex renderer in the real
managed Codex startup path. The switch is intentionally limited to Codex
`config.toml`; QQ SDK, SearXNG preparation, and other MCP registrations remain
unchanged.

## Adoption modes

```toml
[runtime.adoption.codex]
mode = "unified"
```

- `legacy`: use the established generator and remove any stale cutover record;
- `unified-shadow`: keep the legacy config active while refreshing shadow evidence;
- `unified`: require a current compatible shadow report, install the unified
  config, and retain the generated legacy config as the one-shot rollback copy.

The default checked-in production profile now requests `unified`.

## Preconditions

Unified activation is rejected unless `data/config/adoption/codex-shadow.json`
is a valid Schema 2 report whose Codex-scoped fingerprint still matches the
current unified renderer. A missing, stale, tampered, or drifting report causes
the runtime to keep using the legacy generator and leaves the global cutover
gate blocked.

## Atomic installation and rollback copy

The managed Codex home contains two short-lived private files while FLORAL is
running:

```text
CODEX_MANAGED_HOME/config.toml
CODEX_MANAGED_HOME/config.legacy-fallback.toml
```

Both files are written with mode `0600` under a `0700` directory. Installation
uses a unique temporary file, file `fsync`, atomic rename, and a best-effort
directory `fsync`. On shutdown, both files are removed while Codex session and
thread state remain intact.

## Automatic one-shot rollback

If unified Codex startup or the required success-record write fails, FLORAL:

1. stops the failed Codex runtime;
2. atomically replaces `config.toml` with the saved legacy config;
3. starts Codex exactly once more;
4. keeps the recovered legacy runtime online if that retry succeeds;
5. records the rollback without storing error messages or configuration values.

If both unified startup and the legacy retry fail, startup fails with an
`AggregateError` and the bridge/workspace cleanup path runs normally.

## Private cutover record

A successful activation or rollback writes:

```text
data/config/adoption/codex-cutover.json
```

The report contains only fingerprints, status, active-config identity,
error *types*, and a tamper-evident report fingerprint. It never stores API
keys, bridge tokens, complete TOML, or exception messages.

Commands:

```bash
corepack pnpm config:codex-cutover
corepack pnpm config:codex-cutover:json
corepack pnpm config:codex-cutover:check
```

`config:codex-cutover:check` returns exit code `0` only when the current report
proves that the unified config is active for the current Codex-scoped
fingerprint. Missing, stale, rolled-back, failed, or tampered reports return
exit code `2`.

## Expected final diagnostics

While the service is running successfully in unified mode:

```text
config.diagnostics.codex_installed=match
config.diagnostics.codex_shadow=compatible
config.diagnostics.codex_cutover=active
config.cutover.blockers=0
config.cutover.status=ready
```

A recovered rollback remains a healthy service state but an intentionally
blocked cutover state:

```text
config.diagnostics.codex_cutover=rolled-back
config.cutover.status=blocked
```

To return to observation-only operation, set the adoption mode to
`unified-shadow`; for emergency rollback, set it to `legacy`, rebuild, and
restart the service.
