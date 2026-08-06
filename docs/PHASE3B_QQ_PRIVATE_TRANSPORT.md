# Phase 3B — verified QQ C2C private transport

Phase 3B replaces the placeholder QQ adapter contract with the exact
`@tencent-connect/qqbot-nodejs@1.0.4` API used by the official Tencent
QQBot implementation.

The first Phase 3B delivery remains private-chat only. Group, channel,
media, proactive sending, Markdown, and interaction callbacks remain
disabled until their authorization and evidence rules are designed.

## SDK contract

FLORAL now uses these verified SDK exports:

- `QQBot`
- `FileKVStore`
- `kvSessionPersistence`
- `QQBotInboundMessage`
- `MiddlewareContext`
- `ReplyTarget`

The inbound mapping is:

```text
QQBotInboundMessage.messageId   → IncomingMessage.id
QQBotInboundMessage.senderId    → ExternalIdentity.externalUserId
replyTarget.targetId            → ExternalIdentity.conversationId
QQBotInboundMessage.content     → IncomingMessage.text
```

Only `replyTarget.scope === "c2c"` is accepted. Any group or channel
event is ignored before it reaches pairing, authorization, SQLite, or
Codex.

## Startup and reconnect lifecycle

`QQBot.start(signal)` is a long-running gateway operation. FLORAL starts
it in the background, waits for the SDK `ready` event, and only then
marks the transport available to `GatewayService`.

The SDK `resumed` event restores the ready state after a resumed
WebSocket session. The session persistence file is stored under:

```dotenv
QQBOT_SESSION_DIR=./data/qq-session
```

The directory is ignored by Git and must be treated as local credential-
adjacent state. Do not upload it or include it in support bundles.

The transport emits bounded markers only:

```text
qq.transport.ready=ok
qq.transport.resumed=ok
qq.transport.error=<error-type>
```

It does not print AppID, AppSecret, OpenID, message text, reply targets,
or SDK error bodies.

## Passive reply safety

A QQ C2C reply is tied to the inbound message. FLORAL therefore caches:

- the SDK `ReplyTarget`
- the inbound `messageId`
- a short expiry time

The outbound target is reconstructed as:

```ts
{
  ...replyTarget,
  msgId: inboundMessageId,
}
```

Defaults:

```dotenv
QQBOT_REPLY_TARGET_TTL_MS=240000
QQBOT_REPLY_TARGET_CACHE_ENTRIES=256
QQBOT_TEXT_CHUNK_CHARACTERS=1800
QQBOT_MAX_REPLY_CHUNKS=4
QQBOT_OUTBOUND_TIMEOUT_MS=30000
```

Expired targets fail closed. FLORAL does not fall back to a proactive
message and does not send to a guessed OpenID.

Long responses are split sequentially on newline or whitespace when
possible. A response exceeding the total chunk budget is truncated with
an explicit suffix. An uncertain send failure is never retried
automatically because the QQ platform may already have accepted the
message.

## Delivery failures

A final QQ delivery failure does not rerun the agent. The successful
Codex thread remains persisted, and SQLite receives only this bounded
audit event:

```text
transport.delivery_failed
```

The audit payload contains the transport name, response kind, and error
class only. It never stores response text, target IDs, SDK error bodies,
or credentials.

## Offline contract check

Run on Windows and Mac after installation:

```bash
corepack pnpm qq:sdk:check
```

Expected result:

```text
qq.sdk.version=1.0.4
qq.sdk.export.QQBot=ok
qq.sdk.export.FileKVStore=ok
qq.sdk.export.kvSessionPersistence=ok
qq.sdk.contract=ok
```

This catches package drift and missing runtime exports without opening a
QQ network connection.

## Real C2C passive-reply probe

Configure `.env` locally on the Mac:

```dotenv
QQBOT_APP_ID=<local value>
QQBOT_APP_SECRET=<local value>
QQBOT_SESSION_DIR=./data/qq-session
QQBOT_PROBE_TIMEOUT_MS=120000
```

Keep the application in private-chat test scope on the QQ Open Platform.
Then run:

```bash
corepack pnpm qq:private:probe
```

After `qq.probe.gateway=ready`, send one ordinary private QQ message to
the bot. The bot must reply:

```text
FLORAL_QQ_TRANSPORT_OK
```

Expected terminal result:

```text
qq.probe.inbound=c2c
qq.probe.passive_reply=ok
qq.probe.result=ok
```

The probe prints only the input character count. It does not print
OpenIDs, AppID, message IDs, message text, or reply targets.

## Full gateway smoke test

Only after the transport probe passes, set:

```dotenv
QQ_MODE=real
CODEX_MODE=real
MOCK_TRUST_OWNER=false
OWNER_PAIRING_CODE=<at least 12 random characters>
```

Run in the foreground:

```bash
corepack pnpm dev
```

From the intended owner QQ account:

```text
/pair <pairing-code>
/status
hello
/new
/stop
```

The first real full-chain acceptance criterion is:

```text
QQ C2C
→ owner pairing
→ SQLite identity and conversation
→ Codex App Server
→ DeepSeek
→ optional MCP search
→ bounded QQ passive reply
```

Do not install the LaunchAgent until this foreground test passes and the
database owner count is exactly one.

## Deferred capabilities

The following remain intentionally disabled:

- group messages
- QQ channels
- proactive messages
- media upload/download
- Markdown messages
- button interactions
- multiple bot accounts
- remote owner replacement

Each requires a separate policy, identity, storage, and failure-handling
review.
