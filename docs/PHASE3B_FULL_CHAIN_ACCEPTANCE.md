# Phase 3B.2 — real QQ full-chain acceptance

Phase 3B.2 proves the production path in the foreground before FLORAL is
installed as a background service:

```text
QQ C2C
→ owner pairing and SQLite identity
→ managed Codex App Server
→ loopback Responses bridge
→ DeepSeek
→ optional SearXNG MCP
→ bounded QQ passive reply
```

## Managed Agent stack

`CODEX_MODE=real` no longer depends on a manually running bridge or on a
pre-edited global `~/.codex/config.toml`.

`ManagedCodexDeepSeekRuntime` owns the complete local lifecycle:

1. validates the loopback SearXNG service;
2. generates a random in-memory bridge token;
3. starts the Responses bridge on an ephemeral loopback port;
4. writes a temporary mode-0600 Codex configuration;
5. starts Codex App Server with a private `CODEX_HOME`;
6. removes the temporary configuration and stops the bridge on shutdown.

The DeepSeek key remains in the FLORAL process only. It is removed from the
Codex child environment. Codex receives only the temporary bridge token.

## Full-chain probe

Keep all credentials in the Mac-local `.env` and run:

```bash
corepack pnpm qq:full-chain:probe
```

The probe uses the configured persistent `DATABASE_PATH`. When no owner exists,
send this from the intended QQ owner account:

```text
/pair <OWNER_PAIRING_CODE>
```

Then send exactly:

```text
只回复：FLORAL_QQ_FULL_CHAIN_OK
```

Expected terminal result:

```text
qq.full_chain.owner=paired
qq.full_chain.sqlite=ok
qq.full_chain.agent_run=completed
qq.full_chain.thread=created
qq.full_chain.passive_reply=ok
qq.full_chain.result=ok
```

Run the probe a second time after the first process exits. The same owner and
Codex thread should be reused:

```text
qq.full_chain.owner=existing
qq.full_chain.thread=reused
qq.full_chain.result=ok
```

This second run is the process-restart persistence evidence.

The probe never prints the pairing code, credentials, QQ OpenIDs, message IDs,
conversation IDs, prompts, model responses, thread IDs, or tool outputs.

## Network reconnect probe

After full-chain acceptance, run:

```bash
corepack pnpm qq:reconnect:probe
```

After the gateway reports ready, briefly disconnect and restore the Mac network.
Wait for:

```text
qq.reconnect.connection=restored
```

Then send one private QQ message. The bot must reply:

```text
FLORAL_QQ_RECONNECT_OK
```

Expected result:

```text
qq.reconnect.passive_reply=ok
qq.reconnect.result=ok
```

## LaunchAgent gate

Do not install the LaunchAgent until all of these are true:

- first full-chain run passes with exactly one owner;
- second full-chain run reports `thread=reused`;
- reconnect probe passes;
- `storage:doctor`, `searxng:doctor`, compatibility, and bridge fault checks pass;
- foreground shutdown releases QQ, Codex, bridge, and SQLite cleanly.
