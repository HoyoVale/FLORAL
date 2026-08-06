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
import { streamDeepSeekChat } from "./deepseek-stream.js";
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
  #pendingForcedToolName: string | undefined;
  #server: Server | undefined;

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
    const server = this.#server;
    this.#server = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
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
      writeJson(response, 200, {
        ok: true,
        service: "floral-responses-bridge",
        provider: "deepseek",
        capacity: this.#capacity.snapshot(),
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

    let releaseCapacity: () => void;
    try {
      releaseCapacity = await this.#capacity.acquire();
    } catch (error) {
      const capacityError = error instanceof BridgeCapacityError
        ? error
        : new BridgeCapacityError(
            "queue_full",
            this.#capacity.snapshot().queueTimeoutMs,
          );
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

    let capacityReleased = false;
    const releaseCapacityOnce = () => {
      if (capacityReleased) return;
      capacityReleased = true;
      releaseCapacity();
    };
    response.once("finish", releaseCapacityOnce);
    response.once("close", releaseCapacityOnce);
    if (request.destroyed || response.destroyed) {
      releaseCapacityOnce();
      return;
    }

    let body: unknown;
    try {
      body = JSON.parse(await readBody(request, this.#options.maxBodyBytes)) as unknown;
      this.#captureCompatibilityRequest(body);
      const responsesRequest = parseResponsesRequest(body);
      const translated = translateResponsesRequest(
        responsesRequest,
        this.#options.deepSeek.model,
        { reasoningByCallId: this.#reasoningByCallId },
      );
      const forcedToolName = this.#selectForcedTool(
        responsesRequest,
        translated.toolMap,
      );

      response.statusCode = 200;
      response.setHeader("content-type", "text/event-stream; charset=utf-8");
      response.setHeader("cache-control", "no-cache, no-transform");
      response.setHeader("connection", "keep-alive");
      response.setHeader("x-accel-buffering", "no");
      response.flushHeaders();

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

      const abortController = new AbortController();
      request.once("aborted", () => abortController.abort());
      response.once("close", () => {
        if (!response.writableEnded) abortController.abort();
      });

      try {
        for await (const chunk of streamDeepSeekChat(
          translated,
          {
            apiKey: this.#options.deepSeek.apiKey,
            baseUrl: this.#options.deepSeek.baseUrl,
            requestTimeoutMs: this.#options.deepSeek.requestTimeoutMs,
            thinking: this.#options.deepSeek.thinking,
            reasoningEffort: this.#options.deepSeek.reasoningEffort,
            ...(forcedToolName ? { forcedToolName } : {}),
            fetchImpl: this.#options.deepSeek.fetchImpl,
          },
          abortController.signal,
        )) {
          writer.consume(chunk);
        }
        writer.complete();
      } catch (error) {
        const providerError = error instanceof ModelProviderError
          ? error
          : new ModelProviderError({
              kind: "upstream",
              message: error instanceof Error ? error.message : String(error),
              retryable: true,
              cause: error,
            });
        writer.fail(providerError.kind, providerError.message);
      }
    } catch (error) {
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
    }
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

async function readBody(request: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of request) {
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
