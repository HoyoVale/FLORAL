# Phase 4.0E4 — QQ SDK Runtime Options Adoption

Phase 4.0E4 makes the unified configuration authority the production source for
QQ SDK constructor options, persisted session layout, and FLORAL delivery
limits. It keeps a one-shot legacy fallback so a configuration or report
failure does not strand the QQ service offline.

## Scope

The canonical QQ runtime contract contains no credential values. It records:

- reviewed SDK package and version;
- account ID derivation strategy;
- file-backed session persistence and stable session layout;
- token prefetch and redacted logger policy;
- startup, passive-reply cache, chunking, and outbound timeouts;
- a deterministic runtime fingerprint.

`QQBOT_APP_ID` and `QQBOT_APP_SECRET` remain environment-only secrets and are
resolved only when a transport instance is created.

## Runtime adoption

When `runtime.adoption.qq_sdk.mode = "unified"`:

1. FLORAL builds the secret-free runtime contract from effective config.
2. The installed SDK version must match the reviewed version.
3. A `QqTransport` is created from the unified contract.
4. The transport must reach the SDK ready/resumed boundary.
5. A private tamper-evident report is written to
   `data/config/adoption/qq-runtime-options.json`.
6. If unified startup or report writing fails, FLORAL stops that transport and
   retries exactly once with the established legacy options.

The legacy path remains available through:

```toml
[runtime.adoption.qq_sdk]
mode = "legacy"
```

## Commands

```bash
corepack pnpm config:qq-adoption
corepack pnpm config:qq-adoption:json
corepack pnpm config:qq-adoption:check
```

The check returns exit code `0` only when real QQ mode requests unified options,
the report is intact, the installed SDK version matches, and the current
runtime fingerprint is active. It returns `2` for missing, stale, rolled-back,
or invalid adoption evidence.

## Security properties

- credentials never enter runtime fingerprints or reports;
- the logger remains locked to the redacted implementation;
- only the reviewed file persistence and account ID strategy are accepted;
- report files use owner-only permissions and atomic replacement;
- an SDK version change fails the unified gate until compatibility is reviewed;
- probes use the same unified options builder without writing production reports.

## Phase 4.0E3 CLI correction

The MCP adoption CLI now loads the project `.env` before resolving effective
configuration. This removes the false `current_status=disabled` result that
could appear even while the LaunchAgent adoption report and global diagnostics
were active.

## Acceptance

A successful Mac rollout reports:

```text
config.qq_adoption.status=active
config.qq_adoption.active_options=unified
config.qq_adoption.current_status=active
config.diagnostics.qq_runtime=active
config.cutover.status=ready
```

The QQ service must remain ready, reconnect persistence must continue to work,
and the existing Codex/MCP cutover statuses must remain active.
