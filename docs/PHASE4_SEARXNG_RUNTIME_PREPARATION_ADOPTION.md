# Phase 4.0E5 — SearXNG Runtime Preparation Adoption

Phase 4.0E5 moves SearXNG runtime preparation behind the unified FLORAL
configuration authority without making the Docker container public or removing
the checked-in infrastructure recovery path.

## Production contract

`runtime.adoption.searxng.mode = "unified"` makes `searxng:prepare` and
`searxng:up` resolve `config/floral.toml` plus approved environment overrides
before touching the runtime directory.

The secret-free preparation contract fingerprints:

- the pinned official SearXNG image digest;
- the rendered compose projection;
- the rendered `settings.yml` template;
- the loopback service URL and request timeout.

The configured image must be present in
`config/catalog/runtime-compatibility.json` before unified startup is allowed.

## Secret handling

The SearXNG secret remains runtime-only in `infra/searxng/runtime/secret`.
Unified preparation renders `settings.yml` from the typed renderer and replaces
the secret placeholder only at the final private-file boundary. The secret is
never included in native bundles, adoption reports, diagnostics, or
fingerprints.

Runtime directory permissions remain `0700`; secret/settings files remain
`0600` where the platform supports POSIX modes.

## Projection drift

Before unified preparation, the checked-in `infra/searxng/compose.yaml` and
`settings.template.yml` must normalize to the same content as the unified
renderer. This preserves a reviewable Git projection while preventing the
runtime from silently using a different configuration source.

## Runtime observation

After `docker compose up -d` and the health check, FLORAL reads only the bounded
SearXNG `/config` surface already used by configuration diagnostics:

- top-level key names;
- engine names;
- plugin names;
- category names;
- a deterministic fingerprint of those bounded fields.

No raw `/config` response or secret field is persisted.

## Adoption report

Successful unified startup writes:

`data/config/adoption/searxng-runtime-preparation.json`

The report contains the target runtime fingerprint, reviewed image, bounded
`/config` fingerprint and counts, fallback state, and a tamper-evident report
fingerprint. It contains no SearXNG secret or query data.

`config:searxng-adoption:check` re-observes `/config` and requires the current
runtime contract and observation to match the active report.

## Recovery

If unified preparation, startup, health, observation, or adoption recording
fails, `searxng:up` attempts exactly one recovery using the checked-in legacy
settings template. A successful recovery keeps search available but records
`rolled-back`; the global configuration cutover gate becomes blocked until the
unified path is repaired and adopted again.

If both unified and legacy startup fail, the command records `failed` on a
best-effort basis and returns an error.

## Commands

```bash
corepack pnpm searxng:prepare
corepack pnpm searxng:up
corepack pnpm searxng:doctor
corepack pnpm config:searxng-adoption
corepack pnpm config:searxng-adoption:check
corepack pnpm config:diagnostics
corepack pnpm config:cutover:check
```
