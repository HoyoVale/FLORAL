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

## 5.4A-2 — Native typing and outbound sequence ownership

The pinned `@tencent-connect/qqbot-nodejs` 1.0.4 contract exposes `QQBot.sendTyping(target)`. FLORAL now uses that SDK-native path rather than introducing a second REST sender.

The transport boundary is explicit:

- the QQ SDK remains the sole owner of protocol-level passive-reply sequencing;
- FLORAL does not allocate or mutate an independent `msg_seq` for typing;
- text replies continue to carry the cached inbound `msgId` through `QQBot.sendText`;
- native typing uses the cached SDK `ReplyTarget` through `QQBot.sendTyping`;
- typing and text operations share one per-conversation outbound sequencer, so a multi-chunk reply cannot interleave with another FLORAL send in the same conversation;
- a failed operation does not poison the conversation queue or block later delivery.

Typing lifecycle is owned by the gateway/runtime boundary:

1. an agent run starts native typing immediately;
2. long runs refresh the typing signal approximately every 50 seconds;
3. entering an approval wait pauses typing;
4. resolving the approval resumes typing if the same run is still active;
5. final reply, failure reply, `/stop`, or any other outbound text stops the local typing refresh;
6. typing failures are best effort: they are diagnosed but never fail the agent run or suppress the final text reply.

`idle` stops FLORAL's refresh timer; QQ does not provide FLORAL with a separate retract operation for a typing signal already delivered. The following text reply remains the authoritative end of the activity state.

The runtime adoption wrapper forwards conversation activity only when the active transport supports it. Mock and non-QQ transports therefore remain valid without gaining QQ-specific behavior.

## Deliberately deferred to 5.4B

Native Markdown templates and inline approval keyboards remain separate from typing. They add new rendering/callback surfaces and will be connected to the existing approval authority only after their identity and expiry contracts are independently tested.

In particular, approval buttons must remain UI only. They may resolve an existing `QqApprovalBroker` request, but they must never widen `files.write`, authorize shell commands remotely, or bypass Mac-local confirmation.

## Acceptance

### 5.4A

1. Ask the same project-summary question used before Phase 5.4. Raw Markdown markers should no longer be visible.
2. A long answer should be split at semantic boundaries rather than arbitrary character positions.
3. `/status` should be concise and human-readable.
4. `/status --debug` should retain the raw diagnostic contract.
5. `/help` should be compact.
6. Re-run the Phase 5.3 file-change approval smoke test; a fresh one-shot approval must still be required and the exact file write must still succeed.

### 5.4A-2

1. Send a normal question that takes several seconds. QQ should display its native typing state before the final answer arrives.
2. The final reply must still use the triggering message's passive-reply `msgId`; FLORAL must not emit or maintain a parallel `msg_seq`.
3. Trigger a file-change approval. Typing should pause while the approval is waiting and resume after `/approve` or `/deny` if the agent continues.
4. Trigger two outbound sends concurrently in tests. The second send must not enter the SDK before the first send completes.
5. Simulate `sendTyping` failure. Final text delivery must still succeed.
6. Re-run the Phase 5.3 one-shot file-change approval smoke test to confirm authorization semantics are unchanged.
