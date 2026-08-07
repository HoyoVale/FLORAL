export interface ResponsesBridgeRequest {
  model: string;
  instructions?: string | undefined;
  input: unknown;
  tools?: unknown[] | undefined;
  tool_choice?: unknown;
  parallel_tool_calls?: boolean | undefined;
  max_output_tokens?: number | undefined;
  stream?: boolean | undefined;
}

export interface DeepSeekChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  reasoning_content?: string | undefined;
  tool_call_id?: string | undefined;
  tool_calls?: DeepSeekToolCall[] | undefined;
}

export interface DeepSeekToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface DeepSeekFunctionTool {
  type: "function";
  function: {
    name: string;
    description?: string | undefined;
    parameters: Record<string, unknown>;
  };
}

export type OriginalToolKind = "function" | "custom";

export interface ToolBridgeDescriptor {
  deepSeekName: string;
  originalName: string;
  originalNamespace?: string | undefined;
  originalKind: OriginalToolKind;
}

export interface TranslatedDeepSeekRequest {
  model: string;
  messages: DeepSeekChatMessage[];
  tools: DeepSeekFunctionTool[];
  toolMap: Map<string, ToolBridgeDescriptor>;
  maxTokens?: number | undefined;
  parallelToolCalls: boolean;
}

export interface DeepSeekStreamToolCallDelta {
  index: number;
  id?: string | undefined;
  name?: string | undefined;
  arguments?: string | undefined;
}

export interface DeepSeekStreamChunk {
  model?: string | undefined;
  contentDelta?: string | undefined;
  reasoningDelta?: string | undefined;
  toolCallDeltas: DeepSeekStreamToolCallDelta[];
  finishReason?: string | undefined;
  usage?: {
    promptTokens?: number | undefined;
    promptCacheHitTokens?: number | undefined;
    promptCacheMissTokens?: number | undefined;
    completionTokens?: number | undefined;
    reasoningTokens?: number | undefined;
    totalTokens?: number | undefined;
  } | undefined;
}
