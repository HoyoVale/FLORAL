export type ProviderErrorKind =
  | "configuration"
  | "authentication"
  | "payment_required"
  | "rate_limit"
  | "cost_limit"
  | "bad_request"
  | "timeout"
  | "network"
  | "upstream"
  | "protocol"
  | "cancelled";

export interface ModelProviderErrorOptions {
  kind: ProviderErrorKind;
  message: string;
  retryable: boolean;
  status?: number | undefined;
  retryAfterMs?: number | undefined;
  data?: unknown;
  cause?: unknown;
}

export class ModelProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly retryable: boolean;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;
  readonly data: unknown;

  constructor(options: ModelProviderErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = "ModelProviderError";
    this.kind = options.kind;
    this.retryable = options.retryable;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.data = options.data;
  }
}

export function classifyProviderHttpError(
  status: number,
  message: string,
  data?: unknown,
  retryAfterMs?: number,
): ModelProviderError {
  if (status === 401 || status === 403) {
    return new ModelProviderError({
      kind: "authentication",
      message,
      retryable: false,
      status,
      data,
    });
  }
  if (status === 402) {
    return new ModelProviderError({
      kind: "payment_required",
      message,
      retryable: false,
      status,
      data,
    });
  }
  if (status === 408 || status === 429) {
    return new ModelProviderError({
      kind: status === 429 ? "rate_limit" : "timeout",
      message,
      retryable: true,
      status,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      data,
    });
  }
  if (status >= 400 && status < 500) {
    return new ModelProviderError({
      kind: "bad_request",
      message,
      retryable: false,
      status,
      data,
    });
  }

  const retryable = [500, 502, 503, 504].includes(status);
  return new ModelProviderError({
    kind: "upstream",
    message,
    retryable,
    status,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    data,
  });
}

export function redactSecrets(value: string, secrets: Array<string | undefined>): string {
  let redacted = value;
  for (const secret of secrets) {
    if (!secret) continue;
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}
