# Phase 5.1 — Agent Cost Guard & Runaway Protection

Phase 5.1 adds a fail-closed provider boundary after a confirmed self-call storm consumed an abnormal amount of DeepSeek API usage. The guard lives immediately in front of each DeepSeek provider attempt, so Codex tool loops, bridge retries, probes, and repeated Responses calls cannot rely on the language model to stop themselves.

## Enforcement boundary

Production also enforces an idle invariant: if no `AgentRuntime.run()` is active, the bridge rejects a DeepSeek request locally. The narrow exception is Codex Native Memory Phase-2 consolidation: after bridge-token authentication, a request whose `x-openai-subagent` header is exactly `memory_consolidation` may pass the activity gate because Codex intentionally runs that worker asynchronously after the visible run. This exception does **not** bypass the DeepSeek cost guard, request/token/cost budgets, bridge capacity, or provider authentication. Arbitrary idle app-server traffic remains denied.

Every guarded DeepSeek streaming attempt is recorded **before** the HTTP request is allowed to start. The durable state stores only timestamps, model name, SHA-256 request fingerprints, usage counters, and estimated cost. Prompt text, tool output, credentials, and API keys are never stored.

The production `ManagedCodexDeepSeekRuntime`, the standalone Responses Bridge, the direct DeepSeek connectivity probe, and the Codex/bridge integration probes all use the same project cost ledger. Pre-stream retries count as real provider attempts.

## Default rolling limits

The checked-in production policy is intentionally conservative:

- 20 provider attempts / minute
- 120 / hour
- 1000 / rolling 24 hours
- 5M tokens / hour
- 20M tokens / rolling 24 hours
- estimated ¥2 / hour
- estimated ¥10 / rolling 24 hours
- at most 4 semantically identical attempts in 5 minutes
- at most 8 completed/failed attempts with missing usage in one hour

A blocked request is rejected locally before another DeepSeek HTTP request is sent. Provider-side retry logic treats the guard error as non-retryable.

## Duplicate detection

The fingerprint covers the translated provider model, messages, tool definitions, max output tokens, and parallel-tool setting. Volatile tool call IDs are normalized so a loop cannot evade duplicate detection merely by generating fresh call identifiers.

No prompt content is persisted; only the fingerprint is written to disk.

## Usage and estimated cost

DeepSeek's returned usage fields are captured separately:

- `prompt_tokens`
- `prompt_cache_hit_tokens`
- `prompt_cache_miss_tokens`
- `completion_tokens`
- `completion_tokens_details.reasoning_tokens`
- `total_tokens`

Reasoning tokens are a subset of completion tokens and are **not** charged twice by FLORAL's estimator.

The checked-in DeepSeek V4 Flash coefficients were reviewed on 2026-08-07:

- cache-hit input: ¥0.02 / 1M tokens
- cache-miss input: ¥1 / 1M tokens
- output: ¥2 / 1M tokens

These values are configuration, not billing authority. DeepSeek's own billing remains authoritative. `runtime.cost_guard.pricing.model` must match the configured DeepSeek model so a model switch cannot silently retain an unrelated price table.

## Durable state

Default path:

```text
./data/cost-guard/deepseek.json
```

The directory is private (`0700`) and the ledger is `0600` where supported. Writes use a temporary file, file fsync, and atomic rename. The ledger retains only the rolling 24-hour window.

If FLORAL cannot safely establish durable guard state before a request, the provider request is not sent. If a post-request state update fails, the live guard enters fail-closed mode for subsequent requests.

## Operator commands

```bash
corepack pnpm cost:status
corepack pnpm cost:json
corepack pnpm cost:check
```

`cost:check` exits with status 2 when a budget is currently blocking new requests.

QQ `/status` now includes the rolling cost estimate, token budget, request-rate budget, and guard state.

## Scope

This phase protects the DeepSeek provider boundary. It does not yet attempt semantic intent embeddings, remote billing reconciliation, or automatic API-key rotation. Those can be layered on top without weakening this hard local boundary.
