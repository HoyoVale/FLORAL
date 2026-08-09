# Phase 7C.2 — Codex Native Extension Discovery

## Goal

Expose Codex-native extension state to FLORAL without inventing a second Plugin/App system and without enabling unstable Plugin supply-chain mutations.

## Upstream interfaces reused

FLORAL uses the documented Codex App Server read surfaces:

- `app/installed` for effective installed connector App runtime state (`enabled` / `callable`).
- `app/read` for metadata and optional display-only tool summaries.
- `experimentalFeature/list` for lifecycle/enablement metadata of the native `apps` and `plugins` features.

The App Server documentation currently marks `plugin/list`, `plugin/read`, `plugin/install`, and `plugin/uninstall` as under development and says production clients should not call them yet. Phase 7C.2 therefore does not call those RPCs.

## FLORAL surface

Read-only dynamic tools:

- `floral_extensions/native_status`
- `floral_extensions/installed_apps`
- `floral_extensions/read_apps`

Before each Agent turn, FLORAL builds a bounded read-only extension snapshot with `experimentalFeature/list`, `app/installed`, and `app/read`. The dynamic tools read only that snapshot. This avoids issuing a nested client RPC to the same App Server while it is blocked waiting for an `item/tool/call` response.

Chat commands:

- `/apps` — list effective installed/callable Codex Apps.
- `/plugins` — report native plugin/apps feature maturity and FLORAL's integration policy. It is deliberately not an installed-plugin catalog.

No approval is required because this phase is diagnostic/read-only.

## Scope and Project isolation

The managed runtime routes discovery through the Codex App Server associated with the current Project. `app/installed` uses the active Project thread when available; otherwise it uses that Project runtime's configuration. `app/read` is also executed through the selected Project runtime so separate project `CODEX_HOME` state is preserved.

## GitHub and Browser interpretation

GitHub may appear as a connector App. FLORAL must require `app/installed` evidence (`enabled` / `callable`) and may use `app/read` to inspect tool summaries before claiming GitHub tools are usable.

Browser availability must not be inferred from the `plugins` feature flag. The built-in browser host is a separate product capability; Phase 7C.2 reports it as unknown unless a later, supported runtime-specific probe proves otherwise.

## Out of scope

- Plugin marketplace enumeration.
- Plugin install/uninstall or marketplace mutation.
- App configuration writes or OAuth flows.
- App/Plugin `mention` input invocation.
- Browser/Chrome host automation.

Those capabilities require separate compatibility and security review.
