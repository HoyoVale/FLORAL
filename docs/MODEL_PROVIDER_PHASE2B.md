# Model Provider Phase 2B.1 — local Responses bridge

Phase 2B.1 connects Codex's required Responses wire protocol to the validated DeepSeek Chat Completions provider.

```text
Codex App Server
→ POST http://127.0.0.1:<port>/v1/responses
→ FLORAL Responses Bridge
→ POST https://api.deepseek.com/chat/completions
→ DeepSeek V4
```

## Security boundary

- Codex hosted web search is disabled for the DeepSeek bridge because DeepSeek cannot execute OpenAI-hosted `web_search`.
- The bridge continues to reject `web_search` fail-closed instead of pretending it is an executable function.
- The bridge refuses non-loopback bind addresses.
- Every `/v1/responses` request requires a separate local bearer token.
- The bridge token is not the DeepSeek API key.
- The DeepSeek key remains inside the bridge process and is removed from the environment passed to the Codex child process.
- Request bodies and credentials are not logged.
- The request body is bounded to 4 MiB by default.

## Supported in 2B.1

- Responses text and message input
- developer/system/user/assistant messages
- function-call history and function-call outputs
- standard function tools
- Responses custom tools mapped through DeepSeek function tools
- streamed output text
- streamed function/custom tool-call results
- Responses terminal status and token usage
- real Codex App Server → bridge → DeepSeek probe

## Deliberately unsupported

The bridge fails closed for:

- image/file input
- namespace tools
- hosted web search and hosted MCP tools
- Responses compaction endpoints
- encrypted reasoning replay
- Responses WebSocket transport

DeepSeek `reasoning_content` is consumed but never forwarded as raw chain-of-thought.

## Commands

Direct bridge translation probe:

```bash
corepack pnpm bridge:probe
```

Full chain:

```bash
corepack pnpm codex:deepseek:probe
```

Expected:

```text
probe.chain=codex-app-server->floral-bridge->deepseek
probe.initialize=ok
probe.thread=<id>
probe.final="FLORAL_CODEX_DEEPSEEK_OK"
probe.result=ok
```

## Persistent bridge

Generate a local token:

```bash
openssl rand -hex 32
```

Store it only in `.env` as `FLORAL_BRIDGE_TOKEN`, then:

```bash
corepack pnpm bridge:start
```

Merge `config/codex/floral-deepseek-bridge.example.toml` into the target user's Codex config only after both probes pass.
