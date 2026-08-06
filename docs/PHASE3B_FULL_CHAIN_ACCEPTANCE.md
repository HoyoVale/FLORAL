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
4. writes a mode-0600 Codex configuration into the persistent managed home;
5. starts Codex App Server with `CODEX_HOME=./data/codex-runtime` by default;
6. stops Codex and the bridge, then removes only the ephemeral configuration.

Codex thread/session files remain in `CODEX_MANAGED_HOME` across FLORAL process
restarts. The directory is local-only and ignored by Git. The generated bridge
URL and token are rewritten on every startup and `config.toml` is removed during
a clean shutdown.

The DeepSeek key remains in the FLORAL process only. It is removed from the
Codex child environment. Codex receives only the temporary bridge token.

## Full-chain probe

Keep all credentials in the Mac-local `.env`. The real full-chain probe owns
the same exclusive production-stack lock as the LaunchAgent service, so stop the
background service before starting it:

```bash
corepack pnpm service:stop
corepack pnpm qq:full-chain:probe
```

If the service or another probe is still running, the command exits without
opening SQLite, QQ transport, or Codex and reports:

```text
qq.full_chain.blocked_reason=floral-stack-already-running
qq.full_chain.instructions=run-service-stop-before-probe
qq.full_chain.result=blocked
```

After the probe exits, restore the background service with:

```bash
corepack pnpm service:start
corepack pnpm service:status
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

When upgrading from the earlier temporary-`CODEX_HOME` implementation, SQLite
may contain one thread ID whose Codex files were already deleted. The first run
after this fix safely recovers before any turn starts and reports:

```text
codex.thread_resume=stale_reset
qq.full_chain.thread=recovered
qq.full_chain.result=ok
```

Run the probe once more; that next run must report `thread=reused`. This is the
process-restart persistence evidence.

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
