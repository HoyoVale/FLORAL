export type CodexErrorKind =
  | "usage_limit"
  | "authentication"
  | "network"
  | "bad_request"
  | "sandbox"
  | "provider"
  | "request_timeout"
  | "process_exit"
  | "protocol"
  | "interrupted"
  | "unknown";

export interface CodexRuntimeErrorOptions {
  kind: CodexErrorKind;
  message: string;
  retryable?: boolean | undefined;
  method?: string | undefined;
  code?: number | undefined;
  httpStatusCode?: number | undefined;
  codexErrorType?: string | undefined;
  data?: unknown;
  cause?: unknown;
}

export class CodexRuntimeError extends Error {
  readonly kind: CodexErrorKind;
  readonly retryable: boolean;
  readonly method: string | undefined;
  readonly code: number | undefined;
  readonly httpStatusCode: number | undefined;
  readonly codexErrorType: string | undefined;
  readonly data: unknown;

  constructor(options: CodexRuntimeErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CodexRuntimeError";
    this.kind = options.kind;
    this.retryable = options.retryable ?? false;
    this.method = options.method;
    this.code = options.code;
    this.httpStatusCode = options.httpStatusCode;
    this.codexErrorType = options.codexErrorType;
    this.data = options.data;
  }
}

export interface CodexFailureContext {
  method?: string | undefined;
  code?: number | undefined;
  fallbackMessage?: string | undefined;
}

export function classifyCodexFailure(
  value: unknown,
  context: CodexFailureContext = {},
): CodexRuntimeError {
  if (value instanceof CodexRuntimeError) return value;

  const record = findFailureRecord(value);
  const message = readString(record?.message)
    ?? readString(asRecord(value)?.message)
    ?? (value instanceof Error ? value.message : undefined)
    ?? context.fallbackMessage
    ?? "Unknown Codex failure";
  const codexErrorInfo = record?.codexErrorInfo;
  const codexErrorType = readCodexErrorType(codexErrorInfo);
  const httpStatusCode = readHttpStatusCode(codexErrorInfo)
    ?? readNumber(record?.httpStatusCode)
    ?? readNumber(asRecord(value)?.httpStatusCode);
  const normalizedType = normalize(codexErrorType);
  const normalizedMessage = normalize(message);

  if (
    normalizedType.includes("usagelimitexceeded")
    || normalizedType.includes("sessionbudgetexceeded")
    || normalizedMessage.includes("usage limit")
    || normalizedMessage.includes("quota")
    || normalizedMessage.includes("purchase more credits")
    || normalizedMessage.includes("hit your usage limit")
  ) {
    return new CodexRuntimeError({
      kind: "usage_limit",
      message,
      retryable: false,
      method: context.method,
      code: context.code,
      httpStatusCode,
      codexErrorType,
      data: value,
      cause: value instanceof Error ? value : undefined,
    });
  }

  if (
    normalizedType.includes("unauthorized")
    || httpStatusCode === 401
    || httpStatusCode === 403
    || normalizedMessage.includes("unauthorized")
    || normalizedMessage.includes("authentication")
    || normalizedMessage.includes("not logged in")
    || normalizedMessage.includes("invalid api key")
  ) {
    return new CodexRuntimeError({
      kind: "authentication",
      message,
      retryable: false,
      method: context.method,
      code: context.code,
      httpStatusCode,
      codexErrorType,
      data: value,
      cause: value instanceof Error ? value : undefined,
    });
  }

  if (
    normalizedType.includes("httpconnectionfailed")
    || normalizedType.includes("responsestreamconnectionfailed")
    || normalizedType.includes("responsestreamdisconnected")
    || normalizedType.includes("responsetoomanyfailedattempts")
    || normalizedMessage.includes("econnreset")
    || normalizedMessage.includes("econnrefused")
    || normalizedMessage.includes("network")
    || normalizedMessage.includes("connection failed")
    || normalizedMessage.includes("failed to connect")
  ) {
    return new CodexRuntimeError({
      kind: "network",
      message,
      retryable: true,
      method: context.method,
      code: context.code,
      httpStatusCode,
      codexErrorType,
      data: value,
      cause: value instanceof Error ? value : undefined,
    });
  }

  if (
    normalizedType.includes("badrequest")
    || normalizedType.includes("contextwindowexceeded")
    || normalizedType.includes("activeturnnotsteerable")
    || httpStatusCode === 400
  ) {
    return new CodexRuntimeError({
      kind: "bad_request",
      message,
      retryable: false,
      method: context.method,
      code: context.code,
      httpStatusCode,
      codexErrorType,
      data: value,
      cause: value instanceof Error ? value : undefined,
    });
  }

  if (normalizedType.includes("sandboxerror")) {
    return new CodexRuntimeError({
      kind: "sandbox",
      message,
      retryable: false,
      method: context.method,
      code: context.code,
      httpStatusCode,
      codexErrorType,
      data: value,
      cause: value instanceof Error ? value : undefined,
    });
  }

  if (
    normalizedType.includes("internalservererror")
    || normalizedType.includes("other")
    || httpStatusCode === 429
    || (httpStatusCode !== undefined && httpStatusCode >= 500)
  ) {
    return new CodexRuntimeError({
      kind: "provider",
      message,
      retryable: true,
      method: context.method,
      code: context.code,
      httpStatusCode,
      codexErrorType,
      data: value,
      cause: value instanceof Error ? value : undefined,
    });
  }

  return new CodexRuntimeError({
    kind: "unknown",
    message,
    retryable: false,
    method: context.method,
    code: context.code,
    httpStatusCode,
    codexErrorType,
    data: value,
    cause: value instanceof Error ? value : undefined,
  });
}

export function codexRequestTimeout(method: string, timeoutMs: number): CodexRuntimeError {
  return new CodexRuntimeError({
    kind: "request_timeout",
    message: `Codex request timed out after ${timeoutMs} ms: ${method}`,
    retryable: true,
    method,
  });
}

export function codexProcessExit(
  code: number | null,
  signal: NodeJS.Signals | null,
  stderrTail?: string,
): CodexRuntimeError {
  const suffix = stderrTail?.trim() ? `\n${stderrTail.trim()}` : "";
  return new CodexRuntimeError({
    kind: "process_exit",
    message: `Codex app-server exited (code=${String(code)}, signal=${String(signal)})${suffix}`,
    retryable: true,
    data: { code, signal, stderrTail },
  });
}

export function codexProtocolError(message: string, cause?: unknown): CodexRuntimeError {
  return new CodexRuntimeError({
    kind: "protocol",
    message,
    retryable: false,
    cause,
  });
}

function findFailureRecord(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;

  const directError = asRecord(record.error);
  if (directError) return directError;

  const turn = asRecord(record.turn);
  const turnError = asRecord(turn?.error);
  if (turnError) return turnError;

  return record;
}

function readCodexErrorType(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  if (!record) return undefined;

  const explicit = readString(record.type) ?? readString(record.kind);
  if (explicit) return explicit;

  const keys = Object.keys(record);
  return keys.length === 1 ? keys[0] : undefined;
}

function readHttpStatusCode(value: unknown): number | undefined {
  const record = asRecord(value);
  if (!record) return undefined;

  const direct = readNumber(record.httpStatusCode)
    ?? readNumber(record.http_status_code)
    ?? readNumber(asRecord(record.data)?.httpStatusCode);
  if (direct !== undefined) return direct;

  for (const nested of Object.values(record)) {
    const nestedRecord = asRecord(nested);
    const nestedCode = readNumber(nestedRecord?.httpStatusCode)
      ?? readNumber(nestedRecord?.http_status_code);
    if (nestedCode !== undefined) return nestedCode;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalize(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, "");
}
