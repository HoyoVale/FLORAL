# Bridge retry, cancellation, and failure boundaries

Phase 2B.2-B2.2 hardens the local Responses bridge without allowing model or tool work to be duplicated.

## Core invariant

A DeepSeek request may be retried only before the first provider stream chunk has been received. The first chunk is treated as a one-way commit point even when it contains only reasoning metadata or the beginning of a tool call.

After that point FLORAL never automatically replays the provider request. This prevents a model-generated MCP call, future file write, or future macOS action from being produced twice after an ambiguous stream failure.

## Retryable before the commit point

The default is two total attempts, meaning at most one retry. The bridge retries only:

- network establishment failures;
- HTTP 408;
- HTTP 429;
- HTTP 500, 502, 503, or 504.

Provider authentication, payment, request-shape, and protocol failures are not retried. A local per-attempt timeout is also not retried because allowing another full attempt could exceed the enclosing Codex turn deadline.

Retry delay uses bounded exponential backoff with jitter. A provider `Retry-After` value is honored only up to the configured maximum delay.

## Configuration

```dotenv
DEEPSEEK_PRESTREAM_MAX_ATTEMPTS=2
DEEPSEEK_RETRY_BASE_DELAY_MS=250
DEEPSEEK_RETRY_MAX_DELAY_MS=2000
```

`DEEPSEEK_PRESTREAM_MAX_ATTEMPTS` is bounded from 1 to 4. Production should normally remain at 2.

## Cancellation propagation

- Client disconnect while queued removes the request from the bridge queue.
- Client disconnect during a provider request aborts the DeepSeek fetch.
- Bridge shutdown rejects queued requests and aborts active provider requests.
- Cancellation is classified separately from timeout and is never retried.
- A cancelled client receives no synthetic provider response after its socket is gone.

## Streaming protocol failure

DeepSeek SSE must contain valid JSON data frames and terminate with `[DONE]`. Invalid JSON or an EOF before `[DONE]` is classified as a non-retryable protocol failure.

When the failure occurs before the first provider chunk, the bridge returns a bounded JSON provider error without beginning Responses SSE. When it occurs after the stream commit point, the bridge emits one terminal SSE error and does not retry.

## Diagnostics

The loopback bridge health response includes only bounded operational metadata:

```json
{
  "retry": {
    "maxAttempts": 2,
    "totalRetries": 0
  }
}
```

It does not include prompts, credentials, tool arguments, reasoning content, or provider response bodies.

## Validation

```bash
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm bridge:faults:check
corepack pnpm codex:compat:check
corepack pnpm codex:deepseek:web-search:probe
```

The fault suite covers pre-stream recovery, non-retryable provider errors, no replay after text/tool stream start, malformed SSE, queue cancellation, client cancellation, and bridge shutdown.
