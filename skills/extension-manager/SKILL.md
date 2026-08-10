---
name: extension-manager
description: Discover, plan, apply, and verify FLORAL-controlled extension capabilities across curated External MCPs, curated External Skills, and Codex Apps. Use when the user asks to add GitHub/browser/Skill/App capability, change a curated extension lifecycle state, or diagnose why an external capability is unavailable.
---

# FLORAL extension manager

Use the FLORAL/Codex native extension control plane. Do not edit managed Codex configuration, machine-local extension registries, Codex storage, or package directories directly.

## Phase 8E control loop

For a capability gap or lifecycle request, use this order:

1. Call `floral_extensions/plan_extension` with the exact kind/id and requested intent.
2. If the plan is `action-required`, call `floral_extensions/apply_extension` only with the exact `recommended_action`. External MCP/Skill mutations are governed by the exact `extension.<action>` capability and structured target/source/integrity scope.
3. If the plan is `user-handoff`, call `app_permission_review`, then use the supported App handoff (`prepare_app_install`) and let the user complete upstream installation/authentication.
4. After any mutation or App handoff, stop mutation work for the current turn. Report `verification pending`.
5. On a fresh next turn, call `floral_extensions/verify_extension`. Treat its fresh frozen evidence as the controlled-extension verification result.
6. If verification is `degraded`, `prerequisite-required`, or still pending, re-plan from the new snapshot or use `floral_system/diagnose`. Do not reinstall merely to try.

Never use shell, git, npm/pnpm, `codex mcp`, `codex plugin`, direct config edits, registry edits, process inspection, or package-directory inspection to bypass or imitate this loop.

A plan is deterministic guidance from the current frozen System Awareness snapshot and curated catalog. It is not authorization. An approval is not verification. A successful lifecycle command is not runtime readiness.

## Plan statuses

Respect the status exactly:

- `action-required` — the exact recommended lifecycle action may be proposed through `apply_extension`.
- `no-op` — the requested state is already satisfied; do not mutate.
- `prerequisite-required` — a prerequisite such as credential/authentication is missing; do not reinstall to compensate.
- `diagnose-first` — lifecycle state already exists and runtime evidence is unhealthy/ambiguous; diagnose before mutation.
- `user-handoff` — only an upstream user-mediated App install/auth flow is supported.
- `unknown` — authority is insufficient; do not upgrade uncertainty by guessing.
- `unsupported` — FLORAL does not expose the requested lifecycle action.

## Read-only evidence helpers

Use these as supporting views when needed:

- `native_status` for Codex Apps/Plugins feature lifecycle.
- `installed_apps` for installed/callable App runtime authority.
- `available_apps` for App directory visibility separately from installation.
- `read_apps` for App metadata and display-only tool summaries.
- `app_permission_review` for enabled/action tool counts and explicit upstream OAuth-scope uncertainty.
- `prepare_plugin_management` for a supported Plugin browser/install/uninstall/enable/disable handoff.
- `mcp_catalog` for curated External MCP installation/auth prerequisites.
- `mcp_status` for Codex MCP startup/auth/tool discovery state.
- `floral_system/component_status` / `diagnose` for ownership, evidence, and fault-domain interpretation.

A feature flag, directory row, registry entry, or package installation is never enough by itself to claim runtime readiness.

## Apps/connectors

Directory visibility is not runtime installation evidence. If `plan_extension(kind=app, intent=activate)` returns `user-handoff`, call `prepare_app_install` with the exact App id. Return the supported install URL/handoff and let the user complete authentication or connector grants on the upstream surface.

For an installed App, `plan_extension` may return `action-required` with `enable` or `disable`. Call `apply_extension` only with that exact action. FLORAL then uses Codex App Server `config/value/write`, performs immediate native acceptance checking with `app/installed`, records a transaction, and still requires fresh-turn `verify_extension` because the turn's System Awareness snapshot predates the mutation.

Before install, enable, authentication, or first use, call `app_permission_review`. Tool summaries distinguish read-only tools from action tools but are display-only metadata, not authorization. App Server does not expose the provider's complete OAuth scopes through `app/read`; the user must review them on the upstream install/authentication surface. Source-system authorization remains separate from Plugin availability, connector access, Codex runtime policy, and FLORAL approval.

Do not use shell, GUI automation, or Plugin write RPCs to silently install/authenticate an App. The App handoff creates a controlled-extension receipt but does not mean the App was installed.

On a fresh turn after the user completes the flow, call `verify_extension`. Treat the App as complete only when installed-runtime authority reports it installed and callable. If installed authority is unavailable, preserve `pending-user-action`/unknown semantics; never infer callability from the directory.

## Curated External MCPs

Only curated ids may be mutated. Current curated capabilities include:

- `github-readonly` — official GitHub MCP remote endpoint in server-enforced read-only mode.
- `chrome-devtools` — pinned headless Chrome DevTools MCP for browser inspection and controlled browser actions.

Use `plan_extension(kind=mcp, ...)` first. Never call `apply_extension` with a different action than the returned `recommended_action`.

After an approved mutation, hot reload may be scheduled. The current turn's snapshot predates the mutation, so do not claim readiness and do not perform same-turn shell verification. On the next turn, `verify_extension` checks registry state, credential presence where applicable, Codex server state, and discovered tools.

Treat MCP capability as ready only when verification reaches `verified` (normally the fresh Codex MCP view reports `status=ready` with non-empty tools). The current turn's `mcp_status` snapshot predates a same-turn mutation and is not post-change proof. `starting` remains pending. `failed`, `cancelled`, ready-without-tools, or missing expected runtime server are not success.

Do not inspect `~/.codex`, managed package directories, process tables, or registries to create an alternate readiness proof. Do not request a second shell approval for verification: finish the mutation turn with `verification pending`, then use `verify_extension` on a fresh turn.

### GitHub authentication

`github-readonly` references machine-local `GITHUB_PAT_TOKEN`; FLORAL does not expose or persist the token value in extension receipts/System Awareness.

If planning/verification reports a missing credential:

- tell the owner the trusted Mac service environment/untracked `.env` must provide `GITHUB_PAT_TOKEN`;
- do not ask the user to paste the secret into chat;
- do not reinstall the MCP as a credential workaround;
- after the parent service environment changes, restart FLORAL through the governed maintenance surface if needed, then verify on a fresh turn.

## Curated External Skills

Use `plan_extension(kind=skill, ...)` before install/update/enable/disable/remove. `apply_extension` uses only the curated package source and existing External Skill manager; it does not accept arbitrary repositories or refs.

After mutation, fresh-turn `verify_extension` checks the External Skill registry plus expected Skill names in Codex discovery. Do not inspect `data/external-skills` or use git directly as an alternative verification route.

## Plugins

The supported installation/handoff surfaces are the Codex CLI `/plugins` browser and the ChatGPT Plugin Directory. Use `prepare_plugin_management` to explain the exact user action and new-session verification requirement.

Do not call App Server `plugin/list`, `plugin/read`, `plugin/install`, or `plugin/uninstall` from the production Agent as a substitute for the supported surface; those Plugin RPCs remain upstream/under-development rather than FLORAL's managed lifecycle. Do not use shell/Codex storage edits as a bypass.

If the user asks for a Plugin capability not represented by a currently supported App/Skill/MCP route, call `prepare_plugin_management`. Do not manufacture a mutation path that FLORAL has not declared.

## Completion standard

Before saying extension setup is complete, require fresh verification:

- External MCP: controlled receipt + registry expected state + auth prerequisite satisfied + expected Codex server/tool readiness.
- External Skill: controlled receipt + registry expected state + expected Skill names reflected in Codex discovery.
- App: controlled handoff receipt + upstream installed/callable authority; directory visibility alone never closes verification.

Always distinguish `planned`, `approved`, `mutation accepted`, `pending verification`, and `verified`. They are different states.
