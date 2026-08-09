---
name: extension-manager
description: Discover, bootstrap, verify, and safely use FLORAL extension capabilities across Codex Apps, Plugins, and curated MCP servers. Use when the user asks to add GitHub or browser capability, inspect installed Apps/Plugins/MCPs, enable or remove a curated MCP, or diagnose why an external capability is unavailable.
---

# FLORAL extension manager

Use the FLORAL/Codex native extension control plane. Do not edit managed Codex configuration or machine-local extension registries directly.

## Start with evidence

Before claiming an external capability exists, use the relevant `floral_extensions` tool:

- `native_status` for Codex Apps/Plugins feature lifecycle.
- `installed_apps` for effective or compatibility-fallback App state.
- `read_apps` for App metadata and display-only tool summaries.
- `mcp_catalog` for FLORAL-curated MCP install/auth state.
- `mcp_status` for actual MCP startup/auth/tool discovery state.

A feature flag, config entry, package installation, or catalog row is not enough to claim runtime readiness.

## Apps/connectors

When an App is discovered and effective state says it is callable, explicit `$<app-id>` use is supported through Codex's native `app://` mention input.

If FLORAL reports `source=directory-fallback`, `callable=unknown` is intentional. Do not convert accessibility or enabled state into a claim that the App is callable. Use available metadata and runtime evidence.

## Plugins

Do not call App Server `plugin/list`, `plugin/read`, `plugin/install`, or `plugin/uninstall` from the production Agent while those methods remain outside FLORAL's supported production contract.

Do not use shell commands or edit Codex plugin storage to bypass this boundary.

The supported installation handoff is the Codex CLI `/plugins` browser. Explain the required local action concisely when the user wants a Plugin that is not already contributing an App, Skill, or MCP capability. After installation, a new Codex session/runtime may be needed before bundled capabilities appear.

## Curated MCP lifecycle

Use `mcp_catalog` first. Only ids returned by the curated catalog may be passed to `manage_mcp`.

Current curated capabilities include:

- `github-readonly` — official GitHub MCP remote endpoint in server-enforced read-only mode.
- `chrome-devtools` — pinned headless Chrome DevTools MCP for browser inspection and controlled browser actions.

For install/enable/disable/remove:

1. Call `mcp_catalog`.
2. Call `manage_mcp` with the exact curated id and action.
3. Wait for FLORAL's one-shot user approval. Never retry through shell or direct config edits after denial.
4. The mutation may report `hot_reload=scheduled`; do not claim readiness yet.
5. On a later turn or after reload completes, call `mcp_status`.
6. Treat the capability as ready only when FLORAL reports `status=ready` and exposes tools. On Codex builds where `mcpServerStatus/list` omits startup status, FLORAL may infer `ready` from a non-empty discovered tool set; explicit starting/failed/cancelled states still take precedence.

## GitHub authentication

`github-readonly` never stores a PAT in FLORAL's extension registry or generated Codex config. It references the machine-local `GITHUB_PAT_TOKEN` environment variable.

If the catalog or mutation reports `auth=missing`:

- tell the user that `GITHUB_PAT_TOKEN` must be provisioned in the trusted Mac service environment / untracked `.env`;
- do not ask the user to paste the secret into chat;
- after the parent service environment changes, a FLORAL service restart is required so the Codex App Server inherits it;
- then verify with `mcp_status`.

## Browser capability

Do not infer Browser availability from `plugins.enabled=true` or `apps.enabled=true`.

For the headless Mac service, use the curated `chrome-devtools` MCP. Read-only browser inspection should not be treated as a GUI click. Browser actions that Codex classifies as writes are subject to FLORAL `browser.submit` approval.

Do not fall back to AppleScript, `osascript`, `cliclick`, coordinate automation, or direct unmanaged browser-MCP installation.

## Completion standard

Before reporting an extension bootstrap complete, show runtime evidence:

- App: effective callable state when the installed-runtime API is available, or clearly label compatibility-fallback uncertainty.
- MCP: FLORAL `status=ready` plus discovered tools; readiness may be tool-inferred when the list RPC omits startup state. Include auth/failure state when present.
- Plugin: confirmation must come from the supported Codex plugin surface or from the bundled capability appearing in subsequent Codex discovery; a feature flag alone is not installation evidence.
