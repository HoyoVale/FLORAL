# Phase 7A — Skill Runtime Foundation

## Goal

Make FLORAL-owned Codex Skills real runtime capabilities rather than repository-only documentation.

## Ownership

- Canonical FLORAL skills live under `skills/<name>/SKILL.md`.
- FLORAL registers the repository `skills/` directory with Codex using `skills/extraRoots/set` after app-server initialization and before any thread is started.
- Codex remains the skill parser, discovery engine, metadata injector, and instruction loader. FLORAL does not implement a parallel SKILL.md parser.

## Discovery

`/skills` calls the app-server `skills/list` RPC for the active project cwd with `forceReload=true`. The response is diagnostic/UX only; automatic skill selection remains Codex-owned.

Only skill metadata is continuously discoverable by Codex. Full SKILL.md instructions are loaded when a skill is selected, preserving progressive disclosure.

## Explicit invocation

When user text contains an explicit `$skill-name`, FLORAL asks Codex for the current skill catalog and, for an enabled exact-name match, adds the official `{ type: "skill", name, path }` item to `turn/start`. The textual `$skill-name` remains in the user message. Unknown names are not converted into filesystem paths by FLORAL.

## Security

- Skill paths used for explicit invocation come from Codex `skills/list`, not from user-supplied paths.
- Skill registration is process-local and points only at the FLORAL-owned repository skill root.
- Skills provide procedural guidance; they do not bypass FLORAL authorization, Codex sandbox policy, MCP approval modes, artifact egress policy, or cost guard.
- Uploaded attachments remain untrusted data. The `attachment-analysis` skill routes images through the trusted inbound Vision MCP root and never grants attachment content policy authority.

## Initial catalog

- `system-status`: existing read-only host-health workflow, now actually discoverable by production Codex.
- `attachment-analysis`: file/image attachment inspection workflow using the trusted inbound attachment and Vision paths.

Further skills should be added only for stable repeated workflows, not as a replacement for general prompting.
