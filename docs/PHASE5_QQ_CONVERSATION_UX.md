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
- native typing passes the cached SDK `ReplyTarget` unchanged through `QQBot.sendTyping`; unlike passive text replies, the typing activity call does not attach the triggering inbound `msgId`;
- typing and text operations share one per-conversation outbound sequencer, so a multi-chunk reply cannot interleave with another FLORAL send in the same conversation;
- a failed operation does not poison the conversation queue or block later delivery.

Typing lifecycle is owned by the gateway/runtime boundary:

1. an agent run starts native typing immediately;
2. long runs refresh the typing signal approximately every 5 seconds so the QQ client can recover the indicator after foreground/chat-view state changes;
3. entering an approval wait pauses typing;
4. resolving the approval resumes typing if the same run is still active;
5. final reply, failure reply, `/stop`, or any other outbound text stops the local typing refresh;
6. typing failures are best effort: they are diagnosed but never fail the agent run or suppress the final text reply.

Real-device validation after the first 5.4A-2 cut exposed gaps that unit fakes did not model. A one-shot typing signal plus a 50-second refresh cadence was too sparse, so the refresh remains short. A second real-device pass showed that attaching passive-reply `msgId` to `sendTyping` could resolve without an SDK error while producing no visible QQ indicator. FLORAL now follows the official QQ integration contract: text replies attach `msgId`, but `sendTyping` receives the bare `ReplyTarget`. The transport emits one bounded `qq.transport.typing_session=started` diagnostic after the first successful SDK call and retains redacted failure diagnostics.

The same validation exposed a deeper custom-provider tool-loop issue. Responses history may contain an assistant preamble immediately followed by a tool call. FLORAL now replays those as one DeepSeek assistant message containing both `content` and `tool_calls`, injects a provider-only compatibility instruction when tools are present, and requires the provider to continue after tool results until a real user-facing final answer exists. Codex result selection also invalidates pre-tool commentary once later work starts. If a completed turn still has no post-tool final message, FLORAL fails it as a protocol error instead of presenting "I will search..." as if it were the answer.

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

1. Send a normal question that takes several seconds. QQ should display its native typing state before the final answer arrives and refresh it during longer tool work. The service log should contain one `qq.transport.typing_session=started scope=c2c` after the first successful SDK signal.
2. The final text reply must still use the triggering message's passive-reply `msgId`; typing must use a bare `ReplyTarget`. FLORAL must not emit or maintain a parallel `msg_seq`.
3. Trigger a file-change approval. Typing should pause while the approval is waiting and resume after `/approve` or `/deny` if the agent continues.
4. Trigger two outbound sends concurrently in tests. The second send must not enter the SDK before the first send completes.
5. Simulate `sendTyping` failure. Final text delivery must still succeed.
6. Re-run the Phase 5.3 one-shot file-change approval smoke test to confirm authorization semantics are unchanged.

## Phase 5.4A-2.3 — Native typing visibility isolation

Real-device validation can reach `qq.transport.typing_session=started scope=c2c`
without the mobile QQ client rendering a typing indicator. At that point the runtime
has already crossed the FLORAL activity boundary and the SDK promise has resolved;
further Gateway changes would conflate transport behavior with platform/client
visibility.

Use the direct SDK probe to isolate the QQ layer:

```bash
corepack pnpm service:stop
corepack pnpm qq:typing:probe
```

Then send one private message to the bot and watch mobile QQ for the next 20 seconds.
The probe intentionally bypasses GatewayService, AgentRuntime, Codex and DeepSeek and
calls `QQBot.sendTyping(rawReplyTarget)` repeatedly, matching Tencent's official QQBot
gateway integration. It sends a passive text reply only after the observation window
has ended.

Expected terminal evidence:

```text
qq.typing_probe.gateway=ready
qq.typing_probe.inbound=c2c
qq.typing_probe.target_shape=raw-reply-target
qq.typing_probe.signal=1:ok
...
qq.typing_probe.sdk_result=ok
qq.typing_probe.visual_result=manual-check-required
```

Interpretation:

- indicator visible: revisit FLORAL activity lifecycle/timing;
- every `signal=N:ok` but indicator invisible: treat native typing as a best-effort
  QQ platform/client capability and do not keep changing the Agent/Gateway path to
  chase a state the SDK reports as accepted;
- SDK call rejects: capture the sanitized SDK error and debug the QQ transport layer.

The direct 20-second C2C probe was then run against the production bot/account. Eight
consecutive `sendTyping(rawReplyTarget)` calls resolved successfully and the passive
reply succeeded, while mobile QQ rendered no typing state at any point. This freezes
native typing as a non-visual capability for the current deployment rather than a
Gateway defect.

## Phase 5.4A-2.4 — Visible activity fallback

Production now disables the invisible native typing heartbeat by configuration while
retaining `qq:typing:probe` as an isolated diagnostic. Long-running real QQ requests
receive one delayed visible activity message instead:

- no status message is sent for requests that complete before the delay;
- after 6 seconds, at most one message is emitted for the run;
- the message is derived from the latest tool category when available (`search`,
  `reading`, generic tool work, or model processing);
- entering an approval wait cancels the timer because the approval card itself is
  already visible progress;
- `/stop`, final reply, failure, and shutdown cancel the timer;
- activity delivery is best-effort and cannot fail the agent run.

The default production presentation contract is:

```toml
[qq.presentation]
native_typing = false
visible_activity_fallback = true
visible_activity_delay_ms = 6000
```

Typical behavior is therefore:

```text
0-6 s     no extra chat noise
>6 s      正在搜索相关信息…   (or another single contextual status)
final     normal answer
```

This is deliberately not model commentary and is never fed back into the Codex or
DeepSeek conversation history.


### 5.4A-2.4 acceptance

1. A fast request that completes within 6 seconds produces no progress bubble.
2. A longer web-search request produces at most one `正在搜索相关信息…` bubble before the final answer.
3. A long non-tool request produces at most one generic `正在处理，请稍候…` bubble.
4. A request that enters approval waiting does not emit an additional progress bubble after the approval prompt appears.
5. `config:validate` reports `qq.presentation.native_typing=false`, visible fallback enabled, and the configured delay.
6. The direct `qq:typing:probe` remains available for future QQ SDK/client regression checks.
