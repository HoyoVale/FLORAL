# Phase 7C.4 — App Directory and Extension Closure

## Purpose

Close the production-safe extension layer before FLORAL moves into full system-awareness/self-management work.

## Apps

FLORAL treats Codex App directory discovery and installed runtime state as separate evidence lanes:

- `app/list` -> directory/accessibility/local-enabled/install URL.
- `app/installed` -> effective installed runtime state and callable status.
- `app/read` -> metadata and display-only tool summaries.
- `app://<id>` mention -> explicit invocation for callable Apps.

The Agent may prepare an installation handoff from a directory row, but user authentication/connector grants remain user-mediated on the supported surface. Directory visibility never becomes a `callable=true` claim.

## Plugins

Codex Plugin feature state may be observed. FLORAL continues to block production use of App Server `plugin/list`, `plugin/read`, `plugin/install`, and `plugin/uninstall` while upstream marks them under development. The supported installation surface remains the Codex CLI `/plugins` browser or a supported ChatGPT desktop surface.

## Skills and MCP

Existing Skill self-management and curated MCP lifecycle remain unchanged. Browser MCP (`chrome-devtools`) is production-ready when Codex reports tools. GitHub read-only remains a curated MCP bootstrap path when its machine-local secret is provisioned.

## Closure criterion

The extension layer is production-safe when:

- Skills are discoverable/manageable with Project/global scope.
- Apps distinguish directory availability from installed/callable runtime state.
- Plugins expose a clear supported-surface handoff instead of experimental production RPCs.
- MCP capabilities are curated, approval-gated, hot-reloaded, and runtime-verified.

The next phase may build FLORAL System Awareness on top of this capability map without giving the Agent raw configuration mutation access.
