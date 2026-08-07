import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { ModelProviderError } from "../provider/provider-errors.js";
import { ResponsesBridgeError } from "./bridge-errors.js";
import {
  BridgeCapacityError,
  BridgeConcurrencyGate,
} from "./concurrency-gate.js";
import type { DeepSeekStreamChunk, TranslatedDeepSeekRequest } from "./bridge-types.js";
import type { DeepSeekCostGuard } from "../../runtime/cost/deepseek-cost-guard.js";
import type { ProviderActivityGate } from "../../runtime/cost/provider-activity-gate.js";
import { streamDeepSeekChat } from "./deepseek-stream.js";
import {
  type PreStreamRetryEvent,
  streamWithPreStreamRetry,
} from "./retry-policy.js";
import { ResponsesSseWriter } from "./responses-sse.js";
import {
  captureCodexResponsesRequest,
  type CapturedCodexResponsesRequest,
} from "./responses-compat.js";
import {
  parseResponsesRequest,
  translateResponsesRequest,
} from "./responses-translator.js";

export interface ResponsesBridgeServerOptions {
  host: string;
  port: number;
  token: string;
  maxBodyBytes: number;
  capacity?: {
    maxConcurrentRequests: number;
    maxQueuedRequests: number;
    queueTimeoutMs: number;
  } | undefined;
  costGuard?: DeepSeekCostGuard | undefined;
  activityGate?: ProviderActivityGate | undefined;
  compatibilityCapture?: {
    onRequest: (capture: CapturedCodexResponsesRequest) => void;
    onError?: ((error: Error) => void) | undefined;
  } | undefined;
  deepSeek: {
    apiKey: string;
    baseUrl: string;
    model: string;
    requestTimeoutMs: number;
    thinking: "enabled" | "disabled";
    reasoningEffort: "high" | "max";
    retry?: {
      maxAttempts: number;
      baseDelayMs: number;
      maxDelayMs: number;
      jitterRatio?: number | undefined;
      random?: (() => number) | undefined;
      onRetry?: ((event: PreStreamRetryEvent) => void) | undefined;
    } | undefined;
    forceToolNameOnce?: string | undefined;
    forceToolWhenInputContains?: string | undefined;
    onForcedToolSelected?: ((name: string) => void) | undefined;
    fetchImpl?: typeof fetch | undefined;
  };
}

export interface ResponsesBridgeAddress {
  host: string;
  port: number;
  baseUrl: string;
}

export class ResponsesBridgeServer {
  readonly #options: ResponsesBridgeServerOptions;
  readonly #capacity: BridgeConcurrencyGate;
  readonly #reasoningByCallId = new Map<string, string>();
  readonly #requestControllers = new Set<AbortController>();
  #pendingForcedToolName: string | undefined;
  #lastApplyPatchSurface: "custom" | "missing" | undefined;
  #server: Server | undefined;
  #stopping = false;
  #retryCount = 0;

  constructor(options: ResponsesBridgeServerOptions) {
    assertLoopbackHost(options.host);
    if (!options.token.trim()) {
      throw new ResponsesBridgeError({
        kind: "unauthorized",
        status: 500,
        message: "FLORAL bridge token is required",
      });
    }
    if (!options.deepSeek.apiKey.trim()) {
      throw new ResponsesBridgeError({
        kind: "provider",
        status: 500,
        message: "DEEPSEEK_API_KEY is required by the bridge",
      });
    }
    this.#options = options;
    const capacity = options.capacity ?? {
      maxConcurrentRequests: 4,
      maxQueuedRequests: 8,
      queueTimeoutMs: 15_000,
    };
    this.#capacity = new BridgeConcurrencyGate(
      capacity.maxConcurrentRequests,
      capacity.maxQueuedRequests,
      capacity.queueTimeoutMs,
    );
    this.#pendingForcedToolName = options.deepSeek.forceToolNameOnce;
  }

  async start(): Promise<ResponsesBridgeAddress> {
    if (this.#server) return this.address();
    if (this.#stopping) throw new Error("Responses bridge cannot restart after stop");

    const server = createServer((request, response) => {
      void this.#handle(request, response);
    });
    this.#server = server;

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.#options.port, this.#options.host, () => resolve());
    });
    return this.address();
  }

  address(): ResponsesBridgeAddress {
    if (!this.#server) {
      throw new Error("Responses bridge is not started");
    }
    const address = this.#server.address() as AddressInfo;
    return {
      host: this.#options.host,
      port: address.port,
      baseUrl: `http://${formatHost(this.#options.host)}:${address.port}/v1`,
    };
  }

  async stop(): Promise<void> {
    if (this.#stopping) return;
    this.#stopping = true;
    this.#capacity.close();
    for (const controller of this.#requestControllers) {
      controller.abort(new Error("Responses bridge is stopping"));
    }

    const server = this.#server;
    this.#server = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }

  #reportApplyPatchSurface(
    request: ReturnType<typeof parseResponsesRequest>,
  ): void {
    const surface = request.tools?.some((value) => {
      const tool = typeof value === "object" && value !== null
        ? value as Record<string, unknown>
        : undefined;
      return tool?.type === "custom" && tool.name === "apply_patch";
    }) ? "custom" : "missing";
    if (surface === this.#lastApplyPatchSurface) return;
    this.#lastApplyPatchSurface = surface;
    process.stderr.write(`bridge.tool_surface.apply_patch=${surface}\n`);
  }

  #selectForcedTool(
    responsesRequest: ReturnType<typeof parseResponsesRequest>,
    toolMap: ReadonlyMap<string, unknown>,
  ): string | undefined {
    const requestedName = this.#pendingForcedToolName;
    if (!requestedName) return undefined;

    const marker = this.#options.deepSeek.forceToolWhenInputContains;
    if (marker && !responsesRequestContains(responsesRequest, marker)) {
      return undefined;
    }

    const resolvedName = resolveAvailableToolName(requestedName, toolMap);
    if (!resolvedName) return undefined;

    this.#pendingForcedToolName = undefined;
    this.#options.deepSeek.onForcedToolSelected?.(resolvedName);
    return resolvedName;
  }

  #captureCompatibilityRequest(body: unknown): void {
    const capture = this.#options.compatibilityCapture;
    if (!capture) return;
    try {
      capture.onRequest(captureCodexResponsesRequest(body));
    } catch (error) {
      capture.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #rememberReasoning(callId: string, reasoning: string): void {
    if (this.#reasoningByCallId.size >= 128) {
      const oldest = this.#reasoningByCallId.keys().next().value as string | undefined;
      if (oldest) this.#reasoningByCallId.delete(oldest);
    }
    this.#reasoningByCallId.set(callId, reasoning);
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    setSecurityHeaders(response);

    if (request.method === "GET" && request.url === "/health") {
      const costGuard = this.#options.costGuard
        ? await this.#options.costGuard.snapshot().catch(() => undefined)
        : undefined;
      writeJson(response, 200, {
        ok: !this.#stopping,
        service: "floral-responses-bridge",
        provider: "deepseek",
        capacity: this.#capacity.snapshot(),
        retry: {
          maxAttempts: this.#retryOptions().maxAttempts,
          totalRetries: this.#retryCount,
        },
        ...(costGuard ? { costGuard: {
          enabled: costGuard.enabled,
          requestsHour: costGuard.requests.hour,
          tokensHour: costGuard.tokens.hour,
          estimatedCostCnyHour: costGuard.estimatedCostCny.hour,
          blockedReason: costGuard.blockedReason ?? null,
        } } : {}),
      });
      return;
    }

    if (request.method !== "POST" || request.url !== "/v1/responses") {
      writeJson(response, 404, {
        error: { type: "not_found", message: "Only POST /v1/responses is supported" },
      });
      return;
    }

    if (!authorized(request.headers.authorization, this.#options.token)) {
      writeJson(response, 401, {
        error: { type: "unauthorized", message: "Invalid bridge token" },
      });
      return;
    }

    const requestController = new AbortController();
    this.#requestControllers.add(requestController);
    const abortFromRequest = () => {
      if (!requestController.signal.aborted) {
        requestController.abort(new Error("Codex request disconnected"));
      }
    };
    const abortFromResponse = () => {
      if (!response.writableEnded) abortFromRequest();
    };
    request.once("aborted", abortFromRequest);
    response.once("close", abortFromResponse);

    let releaseCapacity: (() => void) | undefined;
    try {
      try {
        releaseCapacity = await this.#capacity.acquire(requestController.signal);
      } catch (error) {
        const capacityError = error instanceof BridgeCapacityError
          ? error
          : new BridgeCapacityError(
              "queue_full",
              this.#capacity.snapshot().queueTimeoutMs,
            );
        if (
          requestController.signal.aborted
          || capacityError.kind === "queue_cancelled"
          || capacityError.kind === "gate_closed"
          || this.#stopping
        ) return;

        response.setHeader(
          "retry-after",
          String(Math.max(1, Math.ceil(capacityError.retryAfterMs / 1_000))),
        );
        writeJson(response, 429, {
          error: {
            type: "capacity",
            kind: capacityError.kind,
            message: capacityError.message,
          },
        });
        return;
      }

      if (requestController.signal.aborted || this.#stopping) return;

      const body = JSON.parse(
        await readBody(request, this.#options.maxBodyBytes, requestController.signal),
      ) as unknown;
      this.#captureCompatibilityRequest(body);
      const responsesRequest = parseResponsesRequest(body);
      const translated = translateResponsesRequest(
        responsesRequest,
        this.#options.deepSeek.model,
        { reasoningByCallId: this.#reasoningByCallId },
      );
      this.#reportApplyPatchSurface(responsesRequest);
      const forcedToolName = this.#selectForcedTool(
        responsesRequest,
        translated.toolMap,
      );

      const retryOptions = this.#retryOptions();
      const streamOptions = {
        apiKey: this.#options.deepSeek.apiKey,
        baseUrl: this.#options.deepSeek.baseUrl,
        requestTimeoutMs: this.#options.deepSeek.requestTimeoutMs,
        thinking: this.#options.deepSeek.thinking,
        reasoningEffort: this.#options.deepSeek.reasoningEffort,
        ...(forcedToolName ? { forcedToolName } : {}),
        fetchImpl: this.#options.deepSeek.fetchImpl,
      };
      const stream = streamWithPreStreamRetry(
        () => guardedDeepSeekStream(
          translated,
          streamOptions,
          this.#options.costGuard,
          this.#options.activityGate,
          requestController.signal,
        ),
        {
          ...retryOptions,
          onRetry: (event) => {
            this.#retryCount += 1;
            this.#options.deepSeek.retry?.onRetry?.(event);
          },
        },
        requestController.signal,
      );
      const iterator = stream[Symbol.asyncIterator]();

      let first: IteratorResult<DeepSeekStreamChunk>;
      try {
        first = await iterator.next();
      } catch (error) {
        const providerError = normalizeProviderError(error);
        if (providerError.kind === "cancelled" || requestController.signal.aborted) return;
        writeProviderJsonError(response, providerError);
        return;
      }

      if (requestController.signal.aborted || response.destroyed) {
        await iterator.return?.(undefined);
        return;
      }

      startSseResponse(response);
      const writer = new ResponsesSseWriter(
        response,
        this.#options.deepSeek.model,
        translated.toolMap,
        (call) => {
          if (call.reasoningContent) {
            this.#rememberReasoning(call.callId, call.reasoningContent);
          }
        },
      );
      writer.start();

      try {
        if (!first.done) writer.consume(first.value);
        while (!first.done) {
          const next = await iterator.next();
          if (next.done) break;
          writer.consume(next.value);
        }
        if (!requestController.signal.aborted && !response.destroyed) {
          writer.complete();
        }
      } catch (error) {
        const providerError = normalizeProviderError(error);
        if (
          providerError.kind !== "cancelled"
          && !requestController.signal.aborted
          && !response.destroyed
          && !response.writableEnded
        ) {
          writer.fail(providerError.kind, providerError.message);
        }
      } finally {
        await iterator.return?.(undefined);
      }
    } catch (error) {
      if (requestController.signal.aborted || response.destroyed) return;
      if (response.headersSent) {
        if (!response.writableEnded) response.end();
        return;
      }
      const bridgeError = error instanceof ResponsesBridgeError
        ? error
        : new ResponsesBridgeError({
            kind: "internal",
            status: 500,
            message: error instanceof Error ? error.message : String(error),
            cause: error,
          });
      writeJson(response, bridgeError.status, {
        error: {
          type: bridgeError.kind,
          message: bridgeError.message,
        },
      });
    } finally {
      releaseCapacity?.();
      this.#requestControllers.delete(requestController);
      request.removeListener("aborted", abortFromRequest);
      response.removeListener("close", abortFromResponse);
    }
  }

  #retryOptions(): {
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
    jitterRatio?: number | undefined;
    random?: (() => number) | undefined;
  } {
    const retry = this.#options.deepSeek.retry;
    return {
      maxAttempts: retry?.maxAttempts ?? 2,
      baseDelayMs: retry?.baseDelayMs ?? 250,
      maxDelayMs: retry?.maxDelayMs ?? 2_000,
      ...(retry?.jitterRatio !== undefined ? { jitterRatio: retry.jitterRatio } : {}),
      ...(retry?.random ? { random: retry.random } : {}),
    };
  }
}

async function* guardedDeepSeekStream(
  request: TranslatedDeepSeekRequest,
  options: Parameters<typeof streamDeepSeekChat>[1],
  costGuard: DeepSeekCostGuard | undefined,
  activityGate: ProviderActivityGate | undefined,
  signal?: AbortSignal,
): AsyncGenerator<DeepSeekStreamChunk> {
  activityGate?.assertProviderRequestAllowed();
  if (!costGuard) {
    yield* streamDeepSeekChat(request, options, signal);
    return;
  }

  const lease = await costGuard.beginAttempt(request);
  let usage: DeepSeekStreamChunk["usage"];
  let status: "completed" | "failed" | "cancelled" = "failed";
  try {
    for await (const chunk of streamDeepSeekChat(request, options, signal)) {
      if (chunk.usage) usage = chunk.usage;
      yield chunk;
    }
    status = "completed";
  } catch (error) {
    if (signal?.aborted || (error instanceof ModelProviderError && error.kind === "cancelled")) {
      status = "cancelled";
    }
    throw error;
  } finally {
    await costGuard.completeAttempt(lease, usage, status).catch((error) => {
      process.stderr.write(
        `bridge.cost_guard.state=error:${error instanceof Error ? error.name : "Error"}\n`,
      );
    });
  }
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

function startSseResponse(response: ServerResponse): void {
  response.statusCode = 200;
  response.setHeader("content-type", "text/event-stream; charset=utf-8");
  response.setHeader("cache-control", "no-cache, no-transform");
  response.setHeader("connection", "keep-alive");
  response.setHeader("x-accel-buffering", "no");
  response.flushHeaders();
}

function writeProviderJsonError(
  response: ServerResponse,
  error: ModelProviderError,
): void {
  const status = providerHttpStatus(error);
  if (error.retryAfterMs !== undefined) {
    response.setHeader(
      "retry-after",
      String(Math.max(1, Math.ceil(error.retryAfterMs / 1_000))),
    );
  }
  writeJson(response, status, {
    error: {
      type: "provider_error",
      kind: error.kind,
      message: error.message,
      retryable: error.retryable,
    },
  });
}

function providerHttpStatus(error: ModelProviderError): number {
  switch (error.kind) {
    case "rate_limit":
    case "cost_limit":
      return 429;
    case "timeout":
      return 504;
    case "bad_request":
      return 400;
    case "authentication":
    case "payment_required":
    case "network":
    case "upstream":
    case "protocol":
    case "configuration":
      return 502;
    case "cancelled":
      return 499;
  }
}

function responsesRequestContains(
  request: ReturnType<typeof parseResponsesRequest>,
  marker: string,
): boolean {
  if (request.instructions?.includes(marker)) return true;
  return unknownValueContains(request.input, marker);
}

function unknownValueContains(value: unknown, marker: string): boolean {
  if (typeof value === "string") return value.includes(marker);
  if (Array.isArray(value)) {
    return value.some((entry) => unknownValueContains(entry, marker));
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some((entry) => unknownValueContains(entry, marker));
  }
  return false;
}

function resolveAvailableToolName(
  requestedName: string,
  toolMap: ReadonlyMap<string, unknown>,
): string | undefined {
  if (toolMap.has(requestedName)) return requestedName;

  const leafName = requestedName.split("__").filter(Boolean).at(-1);
  if (!leafName) return undefined;

  const candidates = [...toolMap.keys()].filter((name) =>
    name === leafName || name.endsWith(`__${leafName}`)
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}

function assertLoopbackHost(host: string): void {
  const normalized = host.toLowerCase();
  if (!["127.0.0.1", "::1", "localhost"].includes(normalized)) {
    throw new ResponsesBridgeError({
      kind: "bad_request",
      status: 500,
      message: `Responses bridge may bind only to loopback, received: ${host}`,
    });
  }
}

function authorized(value: string | undefined, token: string): boolean {
  const prefix = "Bearer ";
  if (!value?.startsWith(prefix)) return false;
  const supplied = Buffer.from(value.slice(prefix.length));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function readBody(
  request: IncomingMessage,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of request) {
    if (signal.aborted) throw signal.reason;
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += chunk.length;
    if (size > maxBytes) {
      throw new ResponsesBridgeError({
        kind: "payload_too_large",
        status: 413,
        message: `Responses request exceeded ${maxBytes} bytes`,
      });
    }
    chunks.push(chunk);
  }
  if (signal.aborted) throw signal.reason;
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) {
    throw new ResponsesBridgeError({
      kind: "bad_request",
      status: 400,
      message: "Responses request body is empty",
    });
  }
  return text;
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function formatHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}
