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
  fetchImpl?: typeof fetch | undefined;
}

export async function* streamDeepSeekChat(
  request: TranslatedDeepSeekRequest,
  options: DeepSeekStreamOptions,
  signal?: AbortSignal,
): AsyncGenerator<DeepSeekStreamChunk> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.requestTimeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
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
                tool_choice: "auto",
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
      );
    }

    if (!response.body) {
      throw new ModelProviderError({
        kind: "protocol",
        message: "DeepSeek streaming response had no body",
        retryable: false,
      });
    }

    for await (const data of readSseData(response.body)) {
      if (data === "[DONE]") return;

      const parsed = parseJson(data);
      const record = asRecord(parsed);
      if (!record) continue;

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
  } catch (error) {
    if (error instanceof ModelProviderError) throw error;
    if (controller.signal.aborted) {
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
  }
}

async function* readSseData(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data) yield data;
        boundary = buffer.indexOf("\n\n");
      }
    }

    buffer += decoder.decode();
    const data = buffer
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data) yield data;
  } finally {
    reader.releaseLock();
  }
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
  const completionTokens = readNumber(usage.completion_tokens);
  const totalTokens = readNumber(usage.total_tokens);
  if (
    promptTokens === undefined
    && completionTokens === undefined
    && totalTokens === undefined
  ) return undefined;

  return {
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
