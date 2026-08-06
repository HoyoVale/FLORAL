import { ModelProviderError } from "../provider/provider-errors.js";

export interface PreStreamRetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio?: number | undefined;
  random?: (() => number) | undefined;
  onRetry?: ((event: PreStreamRetryEvent) => void) | undefined;
}

export interface PreStreamRetryEvent {
  failedAttempt: number;
  nextAttempt: number;
  delayMs: number;
  error: ModelProviderError;
}

export async function* streamWithPreStreamRetry<T>(
  createStream: (attempt: number) => AsyncGenerator<T>,
  options: PreStreamRetryOptions,
  signal?: AbortSignal,
): AsyncGenerator<T> {
  assertOptions(options);

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    throwIfAborted(signal);
    const stream = createStream(attempt);
    let first: IteratorResult<T>;

    try {
      first = await stream.next();
    } catch (error) {
      await closeStream(stream);
      const providerError = normalizeProviderError(error);
      if (!shouldRetryBeforeStream(providerError, attempt, options.maxAttempts, signal)) {
        throw providerError;
      }

      const delayMs = retryDelayMs(providerError, attempt, options);
      options.onRetry?.({
        failedAttempt: attempt,
        nextAttempt: attempt + 1,
        delayMs,
        error: providerError,
      });
      await abortableDelay(delayMs, signal);
      continue;
    }

    if (first.done) {
      await closeStream(stream);
      return;
    }

    try {
      yield first.value;
      while (true) {
        const next = await stream.next();
        if (next.done) return;
        yield next.value;
      }
    } finally {
      await closeStream(stream);
    }
  }
}

export function shouldRetryBeforeStream(
  error: ModelProviderError,
  attempt: number,
  maxAttempts: number,
  signal?: AbortSignal,
): boolean {
  if (signal?.aborted || attempt >= maxAttempts || !error.retryable) return false;

  if (error.kind === "network" || error.kind === "rate_limit") return true;
  if (error.kind === "timeout") return error.status === 408;
  if (error.kind === "upstream") {
    return error.status !== undefined && [500, 502, 503, 504].includes(error.status);
  }
  return false;
}

function retryDelayMs(
  error: ModelProviderError,
  attempt: number,
  options: PreStreamRetryOptions,
): number {
  const exponential = Math.min(
    options.maxDelayMs,
    options.baseDelayMs * (2 ** Math.max(0, attempt - 1)),
  );
  const bounded = Math.min(options.maxDelayMs, error.retryAfterMs ?? exponential);
  const jitterRatio = options.jitterRatio ?? 0.2;
  const random = options.random ?? Math.random;
  const factor = 1 + ((random() * 2) - 1) * jitterRatio;
  return Math.max(0, Math.round(bounded * factor));
}

async function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (delayMs === 0) return;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(cancelledError(signal?.reason));
    };
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function normalizeProviderError(error: unknown): ModelProviderError {
  if (error instanceof ModelProviderError) return error;
  return new ModelProviderError({
    kind: "upstream",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
    cause: error,
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelledError(signal.reason);
}

function cancelledError(cause?: unknown): ModelProviderError {
  return new ModelProviderError({
    kind: "cancelled",
    message: "DeepSeek request was cancelled",
    retryable: false,
    cause,
  });
}

async function closeStream<T>(stream: AsyncGenerator<T>): Promise<void> {
  try {
    await stream.return(undefined);
  } catch {
    // Preserve the original stream result or failure.
  }
}

function assertOptions(options: PreStreamRetryOptions): void {
  if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1 || options.maxAttempts > 4) {
    throw new Error("Pre-stream retry max attempts must be an integer from 1 to 4");
  }
  if (!Number.isInteger(options.baseDelayMs) || options.baseDelayMs < 0) {
    throw new Error("Pre-stream retry base delay must be a non-negative integer");
  }
  if (!Number.isInteger(options.maxDelayMs) || options.maxDelayMs < options.baseDelayMs) {
    throw new Error("Pre-stream retry max delay must be an integer at least as large as base delay");
  }
  const jitterRatio = options.jitterRatio ?? 0.2;
  if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) {
    throw new Error("Pre-stream retry jitter ratio must be between 0 and 1");
  }
}
