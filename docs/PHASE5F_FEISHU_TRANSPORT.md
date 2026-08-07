# Phase 5F — Feishu transport migration

## 5F.0 / 5F.1 scope

This phase begins the migration of FLORAL's primary chat entry from QQ to a
Feishu enterprise self-built application without changing AgentRuntime, Codex,
DeepSeek, MCP, authorization, or SQLite semantics.

The first cut is deliberately non-production:

- add `feishu` to the transport identity type;
- pin the official `@larksuiteoapi/node-sdk@1.36.0`;
- add an offline SDK contract check;
- normalize only `im.message.receive_v1` P2P user text messages;
- add a direct WebSocket private-chat probe that bypasses Gateway/Codex/DeepSeek;
- keep QQ production behavior unchanged;
- do not expose Feishu interactive approvals until basic receive/send is proven.

## Feishu console prerequisites

Use an **enterprise self-built application** with the **Bot** capability.

Minimal permissions for this probe:

- receive private messages sent to the bot:
  `im:message.p2p_msg:readonly` (or `im:message.p2p_msg`);
- send messages as the app bot:
  `im:message:send_as_bot` (or the broader `im:message`).

Event subscription:

- choose **long connection**;
- subscribe to **Receive message v2.0**:
  `im.message.receive_v1`.

The long-connection client needs outbound Internet access but no public IP,
domain, webhook endpoint, or tunnel.

## Secrets

For 5F.1 the Feishu credentials are probe-only environment variables and are not
yet part of FLORAL's federated production config:

```text
FEISHU_APP_ID=...
FEISHU_APP_SECRET=...
FEISHU_PROBE_TIMEOUT_MS=120000
```

Keep the real values only in the untracked local `.env` / process environment.

## Validation

Windows/offline:

```powershell
corepack pnpm install
corepack pnpm feishu:sdk:check
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
git diff --check
```

Mac direct probe:

```bash
corepack pnpm service:stop
corepack pnpm feishu:sdk:check
corepack pnpm feishu:private:probe
```

Then send one **private text message** to the Feishu bot. Expected terminal tail:

```text
feishu.private_probe.inbound=p2p-text
feishu.private_probe.reply=ok
feishu.private_probe.result=ok
```

Expected Feishu reply:

```text
FLORAL 飞书单聊探针已收到消息。Feishu WebSocket + send message API 正常。
```

Only after this passes should Phase 5F.2 wire Feishu into the production
`ChatTransport`, federated config, owner pairing, commands, and service lifecycle.

## 5F.2 — production ChatTransport cutover

The direct P2P probe passed on the target Mac, so Feishu can now enter the real
Gateway path. `CHAT_TRANSPORT=feishu` is the explicit production selector;
when it is absent, legacy `QQ_MODE=real` still selects QQ so existing installs do
not switch transports accidentally.

### Runtime architecture

```text
Feishu Open Platform
        |
        | long connection (im.message.receive_v1)
        v
Feishu WS worker thread
        | normalize + IPC only
        v
FeishuTransport (parent process)
        |
        v
GatewayService -> SQLite -> Codex -> DeepSeek/MCP
```

The pinned SDK long-connection loop is isolated in a worker thread. Event
handlers normalize P2P user text and post it to the parent immediately, then
return without waiting for Gateway/Codex work. This keeps Feishu's event callback
budget separate from potentially long agent runs. The parent process owns the
HTTP message client and can deterministically stop ingress with
`worker.terminate()` even if the pinned SDK connection loop does not expose a
lifecycle contract suitable for FLORAL's service supervisor.

`message_id` is preserved as `IncomingMessage.id`; the existing SQLite message
receipt table therefore remains the authoritative duplicate-delivery guard.
Group messages, bot-originated messages, rich media, and malformed payloads stay
fail-closed in 5F.2.

### Federated configuration

Production credentials become normal SecretRefs and are never written into the
redacted effective configuration:

```text
CHAT_TRANSPORT=feishu
FEISHU_APP_ID=...
FEISHU_APP_SECRET=...
FEISHU_STARTUP_TIMEOUT_MS=30000
FEISHU_OUTBOUND_TIMEOUT_MS=30000
FEISHU_TEXT_CHUNK_BYTES=120000
FEISHU_MAX_REPLY_CHUNKS=4
FEISHU_VISIBLE_ACTIVITY_FALLBACK=true
FEISHU_VISIBLE_ACTIVITY_DELAY_MS=6000
```

The SDK version remains pinned at `1.36.0`, matching the real 5F.1 probe. Version
drift fails startup rather than silently changing long-connection behavior.

### Authorization boundary

5F.2 deliberately does **not** expose `InteractiveApprovalTransport` on Feishu.
Remote-confirmable file changes therefore use the existing text approval ID plus
`/approve <id>` / `/deny <id>` flow. The authorization owner, role,
conversation, TTL, and one-shot checks are unchanged. `shell.execute` remains
Mac-local confirmation only and `system.admin` remains denied.

Native Feishu approval cards are deferred to 5F.3 after the full production text
chain passes.

### 5F.2 acceptance

1. Start the LaunchAgent with `CHAT_TRANSPORT=feishu`, `CODEX_MODE=real`, and a
   private owner pairing code.
2. First private message: `/pair <code>`; the Feishu `open_id` becomes the owner
   identity for this bot App ID.
3. `/status`, `/help`, `/new`, and `/stop` must work through the existing Gateway
   command path.
4. A normal question must complete Feishu -> Gateway -> Codex -> DeepSeek ->
   Feishu without QQ being required.
5. Repeat delivery of the same Feishu `message_id` must be ignored by SQLite.
6. A `files.write` request must show a text approval ID and resolve only once via
   `/approve <id>` or `/deny <id>` from the bound Feishu owner/conversation.
7. `shell.execute` must still require the Mac-local approval mailbox.
8. Stopping/restarting the service must terminate and recreate the Feishu worker
   without leaving an orphan long-connection process.
