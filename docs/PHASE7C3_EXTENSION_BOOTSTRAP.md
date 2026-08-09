# Phase 7C.3 — Extension Installation & Capability Bootstrap

## Goal

Complete FLORAL's extension-capability layer before the later system self-management audit.

This phase keeps four capability domains separate:

1. Skills — Codex-native discovery/configuration, with FLORAL builtin, Project, and shared external scopes.
2. Apps/connectors — Codex-native App discovery and explicit `app://` mention invocation.
3. Plugins — official Codex user-facing plugin browser is recognized, but App Server plugin mutation RPCs remain blocked while upstream documents them as under development for production clients.
4. MCP servers — FLORAL-controlled curated installation/enable/disable/remove, rendered into managed Codex config and activated through native MCP reload/status RPCs.

## Apps

FLORAL first calls `app/installed` to obtain effective `enabled` and `callable` state.

Older/incompatible App Server builds may reject that RPC. For the known protocol compatibility class (`-32601` / `-32602`), FLORAL falls back to `app/list` and reports:

- accessibility,
- enabled state,
- `callable=unknown`.

It never converts directory visibility into a false claim that the App is callable.

When a user explicitly writes `$<app-id>` and the discovered App is enabled/access-allowed, FLORAL adds the native `mention` input item:

`app://<app-id>`

A same-named explicit Skill takes precedence over App mention injection.

## Plugins

The current Plugin feature flag may be stable while App Server plugin-management RPCs are still explicitly documented as under development.

Therefore FLORAL does not call production Agent-side:

- `plugin/list`
- `plugin/read`
- `plugin/install`
- `plugin/uninstall`

The supported installation handoff remains the Codex CLI `/plugins` browser. Installed plugins start contributing bundled Skills/Apps/MCPs to new Codex sessions according to Codex's own plugin lifecycle.

FLORAL will migrate to direct native Plugin management only after the App Server production contract is published and verified on the installed Mac version.

## Curated External MCP registry

Machine-local state:

`data/external-extensions/mcp-registry.json`

The registry stores only package ids, enabled state, and timestamps. It never stores credentials.

Initial curated entries:

### `github-readonly`

- Server id: `github`
- Supply chain: official GitHub MCP remote endpoint
- Transport: Streamable HTTP
- URL: official `/readonly` endpoint
- Authentication: `GITHUB_PAT_TOKEN` environment variable reference
- Server-side read-only mode: required
- FLORAL capability classification: `web.search`

The PAT is a machine-local secret. Generated Codex config contains only `bearer_token_env_var = "GITHUB_PAT_TOKEN"`.

If the variable is absent, the registry may still be installed, but FLORAL reports `auth=missing` and `required_secret=GITHUB_PAT_TOKEN`. Adding the secret after the LaunchAgent has started requires a service restart so the App Server child process inherits the new environment.

### `chrome-devtools`

- Server id: `chrome-devtools`
- Supply chain: pinned `chrome-devtools-mcp@1.6.0`
- Transport: stdio through `npx`
- Mode: slim + headless
- Usage statistics disabled
- Performance CrUX lookup disabled
- Update checks disabled
- Codex default tool approval mode: `writes`
- FLORAL capability classification for approved mutation requests: `browser.submit`

The built-in ChatGPT Browser is not treated as available on the headless Mac service. Browser readiness is based on the actual Chrome DevTools MCP server status and discovered tools.

## Config overlay

External MCP configuration is appended to FLORAL's already-controlled Codex config as a separate machine-local overlay.

This deliberately does not alter the static Phase 4 MCP-registry adoption fingerprint. The static registry still describes FLORAL-owned MCP infrastructure; external extensions are a separate approved runtime layer.

For each global or Project CODEX_HOME:

1. regenerate from the clean active base config,
2. add Project scope/permission profile where applicable,
3. append the current external MCP overlay,
4. atomically replace `config.toml`,
5. call native `config/mcpServer/reload` on every active App Server runtime.

Mutation handling returns to the dynamic tool first and schedules the reload asynchronously, avoiding a nested RPC dependency while App Server is waiting for `item/tool/call` completion.

## Runtime verification

`mcpServerStatus/list` is the authority for MCP readiness.

FLORAL does not claim an MCP capability is usable merely because it is present in registry/config. A usable runtime must report:

- server startup status `ready`, and
- discovered tools.

Authentication/failure details are surfaced when available.

## Agent control plane

`floral_extensions` exposes:

- `native_status`
- `installed_apps`
- `read_apps`
- `mcp_catalog`
- `mcp_status`
- `manage_mcp`

`manage_mcp` accepts only the curated ids and requires a one-shot `software.install` owner approval for install/enable/disable/remove.

The Agent may not bypass this route by editing Codex config, editing the machine-local registry, running `codex mcp ...`, or installing packages with shell commands.

## MCP tool approvals

Peekaboo click approval retains its strict fresh Snapshot ID + opaque element correlation.

Curated External MCP mutation approval is separate:

- only an installed curated server id is eligible,
- lifecycle arguments and approval metadata must match exactly,
- Chrome mutation requests map to `browser.submit`,
- the normal FLORAL authorization broker makes the final user/role decision.

GitHub is configured server-side read-only, so write tools should not be exposed by that MCP configuration.

## Secrets and inventory

`GITHUB_PAT_TOKEN` is a formally inventoried locked environment secret:

- declared in `src/config/env.ts`,
- documented in `.env.example`,
- classified in the configuration catalog,
- represented in configuration authority only as secret presence/reference.

The actual value remains only in the untracked `.env` or parent process environment.

## Production acceptance

After deployment:

1. `/plugins` — verify feature state and Plugin installation policy.
2. `/apps` — verify `app/installed` or compatibility fallback.
3. `/mcp` — verify configured MCP startup/auth/tool state.
4. Install `chrome-devtools` through the Agent; approve once; verify it becomes `ready` with browser tools.
5. Set `GITHUB_PAT_TOKEN` locally, restart the service, install `github-readonly`, and verify GitHub is `ready` with read-only tools.
6. Exercise one read-only GitHub request.
7. Exercise one Browser read action and one write/navigation action; verify the latter produces FLORAL approval.

Only after these checks should the extension layer be treated as ready for the comprehensive FLORAL self-management audit.
