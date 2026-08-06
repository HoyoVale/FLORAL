import { describe, expect, it } from "vitest";
import { ModelProviderError } from "../src/agent/provider/provider-errors.js";
import {
  shouldRetryBeforeStream,
  streamWithPreStreamRetry,
} from "../src/agent/bridge/retry-policy.js";

async function collect<T>(stream: AsyncGenerator<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of stream) values.push(value);
  return values;
}

describe("pre-stream retry policy", () => {
  it("retries a network failure before the first chunk", async () => {
    let attempts = 0;
    const retries: number[] = [];
    const values = await collect(streamWithPreStreamRetry(
      async function* () {
        attempts += 1;
        if (attempts === 1) {
          throw new ModelProviderError({
            kind: "network",
            message: "connection reset",
            retryable: true,
          });
        }
        yield "ok";
      },
      {
        maxAttempts: 2,
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitterRatio: 0,
        onRetry: (event) => retries.push(event.nextAttempt),
      },
    ));

    expect(values).toEqual(["ok"]);
    expect(attempts).toBe(2);
    expect(retries).toEqual([2]);
  });

  it("retries HTTP 429 but caps Retry-After to the configured delay", async () => {
    let attempts = 0;
    const delays: number[] = [];
    await collect(streamWithPreStreamRetry(
      async function* () {
        attempts += 1;
        if (attempts === 1) {
          throw new ModelProviderError({
            kind: "rate_limit",
            message: "slow down",
            retryable: true,
            status: 429,
            retryAfterMs: 60_000,
          });
        }
        yield "ok";
      },
      {
        maxAttempts: 2,
        baseDelayMs: 0,
        maxDelayMs: 1,
        jitterRatio: 0,
        onRetry: (event) => delays.push(event.delayMs),
      },
    ));

    expect(attempts).toBe(2);
    expect(delays).toEqual([1]);
  });

  it("does not retry authentication or protocol errors", () => {
    const authentication = new ModelProviderError({
      kind: "authentication",
      message: "bad key",
      retryable: false,
      status: 401,
    });
    const protocol = new ModelProviderError({
      kind: "protocol",
      message: "bad SSE",
      retryable: false,
    });

    expect(shouldRetryBeforeStream(authentication, 1, 2)).toBe(false);
    expect(shouldRetryBeforeStream(protocol, 1, 2)).toBe(false);
  });

  it("does not retry a local request timeout without HTTP 408", async () => {
    let attempts = 0;
    await expect(collect(streamWithPreStreamRetry(
      async function* () {
        attempts += 1;
        throw new ModelProviderError({
          kind: "timeout",
          message: "attempt exhausted its time budget",
          retryable: true,
        });
      },
      { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
    ))).rejects.toMatchObject({ kind: "timeout" });
    expect(attempts).toBe(1);
  });

  it("never retries after the first provider chunk", async () => {
    let attempts = 0;
    const stream = streamWithPreStreamRetry(
      async function* () {
        attempts += 1;
        yield "started";
        throw new ModelProviderError({
          kind: "network",
          message: "connection reset after output",
          retryable: true,
        });
      },
      { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
    );

    const iterator = stream[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ value: "started", done: false });
    await expect(iterator.next()).rejects.toMatchObject({ kind: "network" });
    expect(attempts).toBe(1);
  });

  it("cancels an in-progress retry delay", async () => {
    const controller = new AbortController();
    let retries = 0;
    const result = collect(streamWithPreStreamRetry(
      async function* () {
        throw new ModelProviderError({
          kind: "network",
          message: "offline",
          retryable: true,
        });
      },
      {
        maxAttempts: 2,
        baseDelayMs: 5_000,
        maxDelayMs: 5_000,
        jitterRatio: 0,
        onRetry: () => {
          retries += 1;
          controller.abort();
        },
      },
      controller.signal,
    ));

    await expect(result).rejects.toMatchObject({ kind: "cancelled" });
    expect(retries).toBe(1);
  });
});
