export type BridgeErrorKind =
  | "unauthorized"
  | "bad_request"
  | "payload_too_large"
  | "unsupported"
  | "provider"
  | "protocol"
  | "internal";

export class ResponsesBridgeError extends Error {
  readonly kind: BridgeErrorKind;
  readonly status: number;
  readonly data: unknown;

  constructor(options: {
    kind: BridgeErrorKind;
    status: number;
    message: string;
    data?: unknown;
    cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = "ResponsesBridgeError";
    this.kind = options.kind;
    this.status = options.status;
    this.data = options.data;
  }
}
