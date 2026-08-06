# Phase 2B.2-A — local SearXNG search MCP

FLORAL uses two independent open-source components:

- SearXNG as the local metasearch service
- `mcp-searxng@1.0.3` as the pinned stdio MCP adapter

```text
DeepSeek V4
→ mcp__floral_search__searxng_web_search
→ Codex App Server
→ mcp-searxng@1.0.3
→ http://127.0.0.1:8888/search?format=json
→ local SearXNG
→ upstream search engines
```

OpenAI-hosted `web_search` remains disabled. This is a separate FLORAL-owned tool path.

## Security boundary

- Docker publishes SearXNG only on `127.0.0.1:8888`.
- `SEARXNG_URL` must be an `http://` loopback URL.
- The SearXNG secret is generated into `infra/searxng/runtime/`, which Git ignores.
- Codex receives only `searxng_web_search`.
- The adapter's `web_url_read` tool is hidden with `enabled_tools`.
- MCP calls are represented as bounded lifecycle events; raw results are not copied into audit events.
- The DeepSeek API key is still removed from the Codex child environment.

## Open-source pinning

The MCP package is pinned to `mcp-searxng@1.0.3`, not `latest`.

The first SearXNG development deployment uses the official `searxng/searxng:latest` image. After the first successful Mac validation, record the pulled image digest and pin it before service rollout.

## Mac commands

Docker Desktop or another Docker-compatible daemon must be running.

```bash
corepack pnpm searxng:up
corepack pnpm searxng:health
```

The first command generates the private runtime settings, starts the container, and waits for the JSON API.

Then validate the complete search tool loop:

```bash
corepack pnpm codex:deepseek:web-search:probe
```

Expected markers:

```text
probe.tool.started=floral_search/searxng_web_search
probe.tool.completed=floral_search/searxng_web_search:completed
probe.final="FLORAL_WEB_SEARCH_OK"
probe.result=ok
```

Stop the development service with:

```bash
corepack pnpm searxng:down
```

## Deliberately deferred

- arbitrary URL reading
- public or LAN exposure
- remote SearXNG instances
- persistent MCP HTTP transport
- production image-digest pinning
- search-result citation rendering in QQ

## Deterministic tool-call probe

The real web-search probe disables DeepSeek thinking for its first provider request and forces the exact flattened MCP function once. This prevents a marker-only answer from passing without a tool call. The override is probe-local; normal FLORAL bridge traffic keeps the configured thinking mode and automatic tool selection.

For normal thinking-mode tool chains, the bridge keeps DeepSeek `reasoning_content` in a bounded in-memory call-id cache and restores it only when Codex returns the corresponding tool output. The reasoning text is not logged or persisted.

### Probe-scoped forced tool selection

The deterministic probe now carries a private marker in its user input. The bridge does not consume the one-shot forced-tool override until a Responses request contains that marker and exposes exactly one matching search tool. This avoids Codex setup or preflight model requests consuming the override before the real probe turn. The probe logs only the selected tool name; prompts, credentials, search results, and reasoning content remain unlogged.
