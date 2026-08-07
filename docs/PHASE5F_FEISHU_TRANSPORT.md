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
