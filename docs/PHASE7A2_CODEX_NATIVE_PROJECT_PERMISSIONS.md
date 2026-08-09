# Phase 7A.2 — Codex-native Project Permissions

## Goal

Complete FLORAL project isolation without creating a second filesystem sandbox or file-policy engine.

Phase 7A.1 isolates each FLORAL project into its own Codex App Server / `CODEX_HOME`, so Codex threads, state SQLite, Native Memory, and project-owned inbound data no longer share one global state domain. Phase 7A.2 closes the remaining filesystem-read gap by selecting a Codex-native named permissions profile for project turns.

## Native App Server integration

FLORAL uses the current Codex App Server experimental permission surface:

- `permissionProfile/list` verifies that the configured project profile exists and is allowed for the project `cwd`.
- `turn/start.permissions` selects that profile.
- `turn/start.runtimeWorkspaceRoots = [cwd]` binds symbolic `:workspace_roots` rules to the active FLORAL project.
- `sandboxPolicy` is omitted whenever `permissions` is present because Codex treats them as mutually exclusive policy selectors.

The project App Server fails closed if the profile cannot be discovered or is blocked by effective Codex requirements. FLORAL does not silently fall back to the broader legacy `workspaceWrite` sandbox in that case.

## Generated project profile

Each project-specific managed Codex config receives one generated profile:

```toml
[permissions.floral-project]
description = "FLORAL project-isolated filesystem profile"

[permissions.floral-project.filesystem]
":minimal" = "read"
"<FLORAL repository>/skills" = "read"
"<DATA_DIR>/projects/<project-key>/inbound/feishu" = "read"

[permissions.floral-project.filesystem.":workspace_roots"]
"." = "write"

[permissions.floral-project.network]
enabled = false
```

The semantics are deliberately narrow:

- `:minimal` lets Codex retain the minimum runtime reads required for sandboxed execution.
- the shared FLORAL Skill root is read-only because system Skills are global capabilities rather than project data.
- the selected project's Feishu inbound root is read-only so ordinary file attachments remain analyzable.
- the selected project root is the sole runtime workspace root and is writable under the existing FLORAL approval/capability flow.
- sibling project roots are not granted and therefore are outside the selected project permission profile.
- network remains disabled for shell execution; web/search capabilities continue through controlled MCP/provider surfaces.

## Project-state layers

After 7A.2 the intended project model is:

- **Codex thread history** — isolated by project `CODEX_HOME`.
- **Codex Native Memory** — isolated by project `CODEX_HOME`.
- **`.floral/` deterministic project context** — stored inside the project directory.
- **project files** — current project is the runtime workspace root.
- **Feishu inbound files/images** — stored under the project data namespace and exposed read-only to the project runtime.
- **system Skills** — shared read-only capability definitions.

DeepSeek Responses Bridge, Cost Guard, Feishu transport, SearXNG, and FLORAL system configuration remain shared infrastructure.

## Compatibility behavior

The named permissions API is version-sensitive. FLORAL enables the App Server experimental API and probes `permissionProfile/list` when a project runtime starts. If the installed Codex does not implement the API or does not accept the generated profile, project runtime startup fails explicitly. This is intentional: project isolation must not silently degrade into cross-project readable filesystem access.

The global/non-project runtime continues to use the existing legacy sandbox path and is not changed by this phase.

## macOS canonical path regression

Project namespace keys are intentionally calculated from canonical `realpath` paths. On macOS, temporary paths commonly resolve from `/var/...` to `/private/var/...`. The Phase 7A.1 test previously hashed the non-canonical fixture path while production hashed the canonical path, causing a test-only mismatch. The regression test now canonicalizes fixture projects before calculating expected namespace keys; production namespace behavior is unchanged.
