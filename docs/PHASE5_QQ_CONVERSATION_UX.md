# Phase 5.4 — QQ Conversation UX

Phase 5.4 improves the QQ private-chat surface without changing the Phase 5.3 authorization boundary.

## 5.4A — Conversation presentation

This baseline adds a presentation layer above the QQ plain-text transport:

- common Markdown is rendered into deterministic mobile-friendly plain text instead of leaking raw `**`, backticks, headings, tables, or fences;
- long replies use semantic paragraph/newline/sentence boundaries and a soft mobile-sized chunk target while preserving the existing hard platform limits;
- `/status` becomes a user-facing summary;
- `/status --debug` preserves the previous key/value diagnostics;
- `/help` documents the small user command surface;
- `/new` and busy-state wording no longer expose Codex thread implementation details.

The fallback formatter intentionally does not change authorization prompts or approval semantics. `QqApprovalBroker`, one-shot file approval, local command confirmation, and system-admin denial remain unchanged.

## Deliberately deferred

Native QQ typing indicators and native Markdown/inline keyboard delivery require a shared passive-reply sequence strategy with the QQ SDK. They are not implemented by bypassing the SDK in this baseline because an independent REST sender could collide with the SDK's `msg_id + msg_seq` deduplication and destabilize the now-working approval/reply chain.

The next 5.4 step should add native interaction only after the SDK sequence ownership is explicit and covered by integration tests.

## Acceptance

1. Ask the same project-summary question used before Phase 5.4. Raw Markdown markers should no longer be visible.
2. A long answer should be split at semantic boundaries rather than arbitrary character positions.
3. `/status` should be concise and human-readable.
4. `/status --debug` should retain the raw diagnostic contract.
5. `/help` should be compact.
6. Re-run the Phase 5.3 file-change approval smoke test; a fresh one-shot approval must still be required and the exact file write must still succeed.
