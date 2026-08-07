import {
  ModelProviderError,
  classifyProviderHttpError,
  redactSecrets,
} from "../provider/provider-errors.js";
import type {
  DeepSeekStreamChunk,
  DeepSeekStreamToolCallDelta,
  TranslatedDeepSeekRequest,
} from "./bridge-types.js";

export interface DeepSeekStreamOptions {
  apiKey: string;
  baseUrl: string;
  requestTimeoutMs: number;
  thinking: "enabled" | "disabled";
  reasoningEffort: "high" | "max";
  forcedToolName?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export async function* streamDeepSeekChat(
  request: TranslatedDeepSeekRequest,
  options: DeepSeekStreamOptions,
  signal?: AbortSignal,
): AsyncGenerator<DeepSeekStreamChunk> {
  const controller = new AbortController();
  let timedOut = false;
  let completed = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("provider request timeout"));
  }, options.requestTimeoutMs);
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    throwIfCancelled(signal);
    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await fetchImpl(
      `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          "authorization": `Bearer ${options.apiKey}`,
          "content-type": "application/json",
          "accept": "text/event-stream",
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          stream: true,
          stream_options: { include_usage: true },
          thinking: { type: options.thinking },
          reasoning_effort: options.reasoningEffort,
          ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
          ...(request.tools.length > 0
            ? {
                tools: request.tools,
                // DeepSeek V4 thinking mode rejects tool_choice. Production
                // requests therefore rely on the provider's default auto
                // selection. A forced name remains available only to explicit
                // compatibility probes.
                ...(options.forcedToolName
                  ? { tool_choice: { type: "function", function: { name: options.forcedToolName } } }
                  : {}),
                parallel_tool_calls: request.parallelToolCalls,
              }
            : {}),
        }),
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      const text = await response.text();
      const data = parseJson(text);
      const providerMessage = readErrorMessage(data)
        ?? `DeepSeek HTTP ${response.status}`;
      throw classifyProviderHttpError(
        response.status,
        redactSecrets(providerMessage, [options.apiKey]),
        data,
        parseRetryAfterMs(response.headers.get("retry-after")),
      );
    }

    if (!response.body) {
      throw new ModelProviderError({
        kind: "protocol",
        message: "DeepSeek streaming response had no body",
        retryable: false,
      });
    }

    let sawDone = false;
    for await (const data of readSseData(response.body)) {
      if (data === "[DONE]") {
        sawDone = true;
        completed = true;
        return;
      }

      const parsed = parseJson(data);
      const record = asRecord(parsed);
      if (!record) {
        throw new ModelProviderError({
          kind: "protocol",
          message: "DeepSeek streaming response contained invalid JSON",
          retryable: false,
        });
      }

      const choices = Array.isArray(record.choices) ? record.choices : [];
      const first = asRecord(choices[0]);
      const delta = asRecord(first?.delta);
      const toolCallDeltas = parseToolCallDeltas(delta?.tool_calls);
      const usage = parseUsage(record.usage);

      yield {
        ...(typeof record.model === "string" ? { model: record.model } : {}),
        ...(typeof delta?.content === "string" && delta.content.length > 0
          ? { contentDelta: delta.content }
          : {}),
        ...(typeof delta?.reasoning_content === "string" && delta.reasoning_content.length > 0
          ? { reasoningDelta: delta.reasoning_content }
          : {}),
        toolCallDeltas,
        ...(typeof first?.finish_reason === "string"
          ? { finishReason: first.finish_reason }
          : {}),
        ...(usage ? { usage } : {}),
      };
    }

    if (!sawDone) {
      throw new ModelProviderError({
        kind: "protocol",
        message: "DeepSeek streaming response ended before [DONE]",
        retryable: false,
      });
    }
  } catch (error) {
    if (error instanceof ModelProviderError) throw error;
    if (signal?.aborted) {
      throw new ModelProviderError({
        kind: "cancelled",
        message: "DeepSeek streaming request was cancelled",
        retryable: false,
        cause: error,
      });
    }
    if (timedOut) {
      throw new ModelProviderError({
        kind: "timeout",
        message: `DeepSeek streaming request timed out after ${options.requestTimeoutMs}ms`,
        retryable: true,
        cause: error,
      });
    }
    throw new ModelProviderError({
      kind: "network",
      message: redactSecrets(error instanceof Error ? error.message : String(error), [
        options.apiKey,
      ]),
      retryable: true,
      cause: error,
    });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
    if (!completed && !controller.signal.aborted) {
      controller.abort(new Error("provider stream closed before completion"));
    }
  }
}

async function* readSseData(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let reachedEof = false;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        reachedEof = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frameData(frame);
        if (data) yield data;
        boundary = buffer.indexOf("\n\n");
      }
    }

    buffer += decoder.decode();
    const trailing = frameData(buffer);
    if (trailing) yield trailing;
  } finally {
    if (!reachedEof) {
      try {
        await reader.cancel();
      } catch {
        // The parent abort may already have closed the reader.
      }
    }
    reader.releaseLock();
  }
}

function frameData(frame: string): string {
  return frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
}

function parseToolCallDeltas(value: unknown): DeepSeekStreamToolCallDelta[] {
  if (!Array.isArray(value)) return [];
  const results: DeepSeekStreamToolCallDelta[] = [];

  for (const entry of value) {
    const call = asRecord(entry);
    const fn = asRecord(call?.function);
    const index = typeof call?.index === "number" ? call.index : results.length;
    results.push({
      index,
      ...(typeof call?.id === "string" ? { id: call.id } : {}),
      ...(typeof fn?.name === "string" ? { name: fn.name } : {}),
      ...(typeof fn?.arguments === "string" ? { arguments: fn.arguments } : {}),
    });
  }
  return results;
}

function parseUsage(value: unknown): DeepSeekStreamChunk["usage"] {
  const usage = asRecord(value);
  if (!usage) return undefined;
  const promptTokens = readNumber(usage.prompt_tokens);
  const promptCacheHitTokens = readNumber(usage.prompt_cache_hit_tokens);
  const promptCacheMissTokens = readNumber(usage.prompt_cache_miss_tokens);
  const completionTokens = readNumber(usage.completion_tokens);
  const completionDetails = asRecord(usage.completion_tokens_details);
  const reasoningTokens = readNumber(completionDetails?.reasoning_tokens);
  const totalTokens = readNumber(usage.total_tokens);
  if (
    promptTokens === undefined
    && completionTokens === undefined
    && totalTokens === undefined
  ) return undefined;

  return {
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(promptCacheHitTokens !== undefined ? { promptCacheHitTokens } : {}),
    ...(promptCacheMissTokens !== undefined ? { promptCacheMissTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function readErrorMessage(value: unknown): string | undefined {
  const record = asRecord(value);
  const error = asRecord(record?.error);
  return typeof error?.message === "string" ? error.message : undefined;
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1_000);
  }
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, date - Date.now());
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new ModelProviderError({
    kind: "cancelled",
    message: "DeepSeek streaming request was cancelled",
    retryable: false,
    cause: signal.reason,
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
