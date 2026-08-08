# Phase 6B.1 — Approval-Gated Element Click

Phase 6B.1 introduces the first FLORAL-controlled macOS GUI mutation capability.
The scope is intentionally limited to one background click on a fresh Peekaboo
snapshot element. No other GUI input capability is activated in this phase.

## Public tool surface

`floral_peekaboo` exposes exactly:

- `image` — read-only screenshot capture.
- `see` — read-only screenshot + Accessibility element map.
- `click` — one approval-gated element click.

`click` accepts only:

- `snapshot`: the fresh Snapshot ID returned by `floral_peekaboo/see`.
- `on`: the opaque element ID copied from that same `see` result.
- `intent`: a short model-declared reason shown in FLORAL's approval flow.

FLORAL does not expose raw coordinates, text-query clicking, explicit PID targeting,
foreground activation, right click, double click, drag, typing, paste, hotkeys, app
launching, window mutation, menu commands, dialogs, or shell control through this MCP.

## Execution contract

The gateway forces the upstream Peekaboo click to:

- background delivery;
- one left single-click;
- a bounded wait time;
- the exact snapshot and opaque element ID supplied by the model.

Peekaboo invalidates the used snapshot after the click. The model must call `see`
again before another GUI action. This produces a deterministic observe → mutate →
observe loop and prevents stale element IDs from being reused.

## Approval boundary

Read-only `image` and `see` remain `approval_mode = "approve"`.

`click` is `approval_mode = "prompt"`, while the server default is also `prompt`.
Codex's MCP approval elicitation is not treated as the final authority. FLORAL maps
`floral_peekaboo/click` to `application.control`, evaluates it through the existing
AuthorizationAuthority, and delegates the one-shot decision to the existing
owner/conversation-scoped remote Approval Broker.

No session or persistent MCP approval is granted. Approval is one call only.

## Sandbox boundary

The base Codex sandbox remains read-only. Phase 6B.1 adds only a narrow authorization
exception for the exact active MCP tuple:

`floral_peekaboo/click` → `application.control`

Generic FLORAL application control, unknown Peekaboo tools, and widened tool surfaces
remain denied.

## Artifact boundary

Only `floral_peekaboo/image`, `floral_peekaboo/see`, and FLORAL vision tools can be
trusted artifact producers. `click` cannot introduce an outbound artifact producer.

## macOS boundary

The upstream MCP process remains pinned to the permissioned Peekaboo Bridge Unix
socket. FLORAL still does not inherit the parent process environment and does not
expose Peekaboo's own AI providers.

## Out of scope

Typing, press, scroll, hotkey, paste, drag, app/window/menu/dialog control, coordinate
clicks, autonomous multi-action plans, and persistent GUI approvals are deferred to
later Phase 6B increments.

## Audit observability

The existing SQLite audit remains authoritative. Phase 6B.1 additionally mirrors only
`agent.tool.started=<server/tool>` and `agent.tool.completed=<server/tool>` to the
service stderr log. Tool arguments, screenshots, page text, and tool results are not
written by this mirror.
