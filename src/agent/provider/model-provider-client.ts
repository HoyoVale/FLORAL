export type ProviderMessageRole = "system" | "user" | "assistant" | "tool";

export interface ProviderMessage {
  role: ProviderMessageRole;
  content: string;
}

export interface ProviderCompletionRequest {
  messages: ProviderMessage[];
  model?: string | undefined;
  maxTokens?: number | undefined;
}

export interface ProviderUsage {
  promptTokens?: number | undefined;
  promptCacheHitTokens?: number | undefined;
  promptCacheMissTokens?: number | undefined;
  completionTokens?: number | undefined;
  reasoningTokens?: number | undefined;
  totalTokens?: number | undefined;
}

export interface ProviderCompletionResult {
  provider: string;
  model: string;
  text: string;
  finishReason?: string | undefined;
  usage?: ProviderUsage | undefined;
}

export interface ModelProviderClient {
  readonly name: string;
  complete(request: ProviderCompletionRequest): Promise<ProviderCompletionResult>;
}
