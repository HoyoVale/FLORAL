import type {
  ModelProviderClient,
  ProviderCompletionRequest,
  ProviderCompletionResult,
  ProviderUsage,
} from "./model-provider-client.js";
import {
  ModelProviderError,
  classifyProviderHttpError,
  redactSecrets,
} from "./provider-errors.js";

export interface DeepSeekClientOptions {
  apiKey: string;
  baseUrl?: string | undefined;
  model?: string | undefined;
  requestTimeoutMs?: number | undefined;
  thinking?: "enabled" | "disabled" | undefined;
  reasoningEffort?: "high" | "max" | undefined;
  fetchImpl?: typeof fetch | undefined;
}

interface DeepSeekResponse {
  model?: unknown;
  choices?: unknown;
  usage?: unknown;
  error?: unknown;
}

export class DeepSeekClient implements ModelProviderClient {
  readonly name = "deepseek";
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #model: string;
  readonly #requestTimeoutMs: number;
  readonly #thinking: "enabled" | "disabled";
  readonly #reasoningEffort: "high" | "max";
  readonly #fetch: typeof fetch;

  constructor(options: DeepSeekClientOptions) {
    if (!options.apiKey.trim()) {
      throw new ModelProviderError({
        kind: "configuration",
        message: "DEEPSEEK_API_KEY is required",
        retryable: false,
      });
    }

    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? "https://api.deepseek.com").replace(/\/+$/, "");
    this.#model = options.model ?? "deepseek-v4-flash";
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    this.#thinking = options.thinking ?? "enabled";
    this.#reasoningEffort = options.reasoningEffort ?? "high";
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async complete(request: ProviderCompletionRequest): Promise<ProviderCompletionResult> {
    if (request.messages.length === 0) {
      throw new ModelProviderError({
        kind: "bad_request",
        message: "DeepSeek completion requires at least one message",
        retryable: false,
      });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#requestTimeoutMs);

    try {
      const response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "authorization": `Bearer ${this.#apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: request.model ?? this.#model,
          messages: request.messages,
          stream: false,
          thinking: { type: this.#thinking },
          reasoning_effort: this.#reasoningEffort,
          ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
        }),
        signal: controller.signal,
      });

      const data = await readJsonBody(response, this.#apiKey);

      if (!response.ok) {
        const message = redactSecrets(readProviderMessage(data) ?? `DeepSeek HTTP ${response.status}`, [
          this.#apiKey,
        ]);
        throw classifyProviderHttpError(response.status, message, data);
      }

      return parseCompletion(data);
    } catch (error) {
      if (error instanceof ModelProviderError) throw error;
      if (controller.signal.aborted) {
        throw new ModelProviderError({
          kind: "timeout",
          message: `DeepSeek request timed out after ${this.#requestTimeoutMs}ms`,
          retryable: true,
          cause: error,
        });
      }
      throw new ModelProviderError({
        kind: "network",
        message: redactSecrets(error instanceof Error ? error.message : String(error), [this.#apiKey]),
        retryable: true,
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

async function readJsonBody(response: Response, apiKey: string): Promise<DeepSeekResponse> {
  const text = await response.text();
  if (!text) return {};

  try {
    return JSON.parse(text) as DeepSeekResponse;
  } catch (error) {
    throw new ModelProviderError({
      kind: "protocol",
      message: redactSecrets(`DeepSeek returned invalid JSON: ${text.slice(0, 300)}`, [apiKey]),
      retryable: false,
      status: response.status,
      cause: error,
    });
  }
}

function parseCompletion(data: DeepSeekResponse): ProviderCompletionResult {
  const choices = Array.isArray(data.choices) ? data.choices : undefined;
  const first = asRecord(choices?.[0]);
  const message = asRecord(first?.message);
  const text = message?.content;

  if (typeof text !== "string") {
    throw new ModelProviderError({
      kind: "protocol",
      message: "DeepSeek response did not contain choices[0].message.content",
      retryable: false,
      data,
    });
  }

  const model = typeof data.model === "string" ? data.model : "unknown";
  const finishReason = typeof first?.finish_reason === "string"
    ? first.finish_reason
    : undefined;
  const usage = parseUsage(data.usage);

  return {
    provider: "deepseek",
    model,
    text,
    ...(finishReason ? { finishReason } : {}),
    ...(usage ? { usage } : {}),
  };
}

function parseUsage(value: unknown): ProviderUsage | undefined {
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
  ) {
    return undefined;
  }

  return {
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(promptCacheHitTokens !== undefined ? { promptCacheHitTokens } : {}),
    ...(promptCacheMissTokens !== undefined ? { promptCacheMissTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

function readProviderMessage(data: DeepSeekResponse): string | undefined {
  const error = asRecord(data.error);
  if (typeof error?.message === "string") return error.message;
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
