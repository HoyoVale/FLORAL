# Model Provider Phase 2A — DeepSeek baseline

Phase 2A validates the model provider independently from Codex App Server.

## Why this phase is separate

Codex App Server currently expects a Responses-compatible provider path. DeepSeek V4 exposes OpenAI Chat Completions and Anthropic-compatible APIs. FLORAL therefore does not point Codex directly at DeepSeek and pretend the protocols are equivalent.

The sequence is:

```text
Phase 2A
FLORAL direct provider probe
→ DeepSeek /chat/completions
→ authentication / model / timeout / error validation

Phase 2B
Codex Responses request
→ local FLORAL ModelBridge
→ DeepSeek Chat Completions
→ Responses-compatible stream back to Codex
```

## Configuration

Copy `.env.example` to `.env` and set only the real key locally:

```dotenv
DEEPSEEK_API_KEY=...
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash
DEEPSEEK_REQUEST_TIMEOUT_MS=120000
DEEPSEEK_THINKING=enabled
DEEPSEEK_REASONING_EFFORT=high
```

`.env` is loaded through Node's built-in environment-file loader and remains excluded from Git.

## Probe

```bash
corepack pnpm deepseek:probe
```

Success:

```text
probe.result=ok
```

The probe never prints the API key. Provider error messages are classified and the key is redacted even when an upstream error happens to echo it.

## Scope

Included:

- non-streaming Chat Completions baseline
- thinking and reasoning-effort fields
- authentication, payment, rate-limit, timeout, network, upstream, bad-request, and protocol errors
- response and token-usage parsing
- fake HTTP provider tests
- `.env` loading for the application and probes

Not included yet:

- Codex Responses API translation
- streaming SSE translation
- function/tool-call conversion
- reasoning-item conversion
- retry scheduling
- production rate limiting
