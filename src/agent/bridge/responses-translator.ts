import { ResponsesBridgeError } from "./bridge-errors.js";
import type {
  DeepSeekChatMessage,
  DeepSeekFunctionTool,
  DeepSeekToolCall,
  ResponsesBridgeRequest,
  ToolBridgeDescriptor,
  TranslatedDeepSeekRequest,
} from "./bridge-types.js";

const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const NAMESPACE_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function parseResponsesRequest(value: unknown): ResponsesBridgeRequest {
  const record = asRecord(value);
  if (!record) {
    throw badRequest("Responses request body must be an object");
  }
  if (typeof record.model !== "string" || record.model.trim() === "") {
    throw badRequest("Responses request requires a non-empty model");
  }
  if (!("input" in record)) {
    throw badRequest("Responses request requires input");
  }

  return {
    model: record.model,
    input: record.input,
    ...(typeof record.instructions === "string" ? { instructions: record.instructions } : {}),
    ...(Array.isArray(record.tools) ? { tools: record.tools } : {}),
    ...("tool_choice" in record ? { tool_choice: record.tool_choice } : {}),
    ...(typeof record.parallel_tool_calls === "boolean"
      ? { parallel_tool_calls: record.parallel_tool_calls }
      : {}),
    ...(typeof record.max_output_tokens === "number"
      ? { max_output_tokens: record.max_output_tokens }
      : {}),
    ...(typeof record.stream === "boolean" ? { stream: record.stream } : {}),
  };
}

export interface ResponsesTranslationContext {
  reasoningByCallId?: ReadonlyMap<string, string> | undefined;
}

export function translateResponsesRequest(
  request: ResponsesBridgeRequest,
  targetModel: string,
  context: ResponsesTranslationContext = {},
): TranslatedDeepSeekRequest {
  const toolMap = new Map<string, ToolBridgeDescriptor>();
  const tools = translateTools(request.tools ?? [], toolMap);
  const messages: DeepSeekChatMessage[] = [];

  if (request.instructions?.trim()) {
    messages.push({ role: "system", content: request.instructions });
  }

  if (typeof request.input === "string") {
    messages.push({ role: "user", content: request.input });
  } else if (Array.isArray(request.input)) {
    for (const item of request.input) {
      translateInputItem(item, messages, toolMap, context);
    }
  } else {
    throw badRequest("Responses input must be a string or an array of input items");
  }

  if (messages.length === 0) {
    throw badRequest("Responses input produced no provider messages");
  }

  return {
    model: targetModel,
    messages,
    tools,
    toolMap,
    parallelToolCalls: request.parallel_tool_calls ?? true,
    ...(Number.isInteger(request.max_output_tokens) && (request.max_output_tokens ?? 0) > 0
      ? { maxTokens: request.max_output_tokens }
      : {}),
  };
}

function translateTools(
  values: unknown[],
  toolMap: Map<string, ToolBridgeDescriptor>,
): DeepSeekFunctionTool[] {
  const tools: DeepSeekFunctionTool[] = [];

  for (const value of values) {
    const tool = asRecord(value);
    const type = readString(tool?.type);
    if (!tool || !type) throw badRequest("Each Responses tool must be an object with a type");

    if (type === "function") {
      const name = requireToolName(tool.name, type);
      registerTool(toolMap, {
        deepSeekName: name,
        originalName: name,
        originalKind: "function",
      });
      tools.push({
        type: "function",
        function: {
          name,
          ...(typeof tool.description === "string" ? { description: tool.description } : {}),
          parameters: readParameters(tool),
        },
      });
      continue;
    }

    if (type === "custom") {
      const name = requireToolName(tool.name, type);
      registerTool(toolMap, {
        deepSeekName: name,
        originalName: name,
        originalKind: "custom",
      });
      tools.push({
        type: "function",
        function: {
          name,
          ...(typeof tool.description === "string" ? { description: tool.description } : {}),
          parameters: {
            type: "object",
            properties: {
              input: {
                type: "string",
                description: "Raw input for the custom Codex tool.",
              },
            },
            required: ["input"],
            additionalProperties: false,
          },
        },
      });
      continue;
    }

    if (type === "namespace") {
      translateNamespaceTool(tool, tools, toolMap);
      continue;
    }

    throw new ResponsesBridgeError({
      kind: "unsupported",
      status: 400,
      message: `Unsupported Responses tool type: ${type}`,
      data: { type },
    });
  }

  return tools;
}

function translateNamespaceTool(
  namespace: Record<string, unknown>,
  tools: DeepSeekFunctionTool[],
  toolMap: Map<string, ToolBridgeDescriptor>,
): void {
  const namespaceName = readString(namespace.name);
  if (!namespaceName || !NAMESPACE_NAME_PATTERN.test(namespaceName)) {
    throw badRequest(
      `namespace tool name must match ${NAMESPACE_NAME_PATTERN.source}`,
    );
  }

  if (!Array.isArray(namespace.tools)) {
    throw badRequest(`namespace ${namespaceName} requires a tools array`);
  }

  for (const value of namespace.tools) {
    const child = asRecord(value);
    if (!child || child.type !== "function") {
      throw new ResponsesBridgeError({
        kind: "unsupported",
        status: 400,
        message: `Namespace ${namespaceName} contains a non-function tool`,
        data: { namespace: namespaceName, childType: child?.type },
      });
    }

    const childName = requireToolName(child.name, "namespace function");
    const flattenedName = flattenNamespaceName(namespaceName, childName);
    const description = joinDescriptions(namespace.description, child.description);

    registerTool(toolMap, {
      deepSeekName: flattenedName,
      originalName: childName,
      originalNamespace: namespaceName,
      originalKind: "function",
    });

    tools.push({
      type: "function",
      function: {
        name: flattenedName,
        ...(description ? { description } : {}),
        parameters: readParameters(child),
      },
    });
  }
}

function flattenNamespaceName(namespaceName: string, childName: string): string {
  const flattened = namespaceName.endsWith("__")
    ? `${namespaceName}${childName}`
    : `${namespaceName}__${childName}`;

  if (!TOOL_NAME_PATTERN.test(flattened)) {
    throw badRequest(
      `Flattened namespace tool name must match ${TOOL_NAME_PATTERN.source}: ${flattened}`,
    );
  }
  return flattened;
}

function registerTool(
  toolMap: Map<string, ToolBridgeDescriptor>,
  descriptor: ToolBridgeDescriptor,
): void {
  if (toolMap.has(descriptor.deepSeekName)) {
    throw badRequest(`Duplicate translated tool name: ${descriptor.deepSeekName}`);
  }
  toolMap.set(descriptor.deepSeekName, descriptor);
}

function readParameters(tool: Record<string, unknown>): Record<string, unknown> {
  return asRecord(tool.parameters)
    ?? asRecord(tool.inputSchema)
    ?? asRecord(tool.input_schema)
    ?? { type: "object", properties: {} };
}

function joinDescriptions(namespaceDescription: unknown, childDescription: unknown): string | undefined {
  const parts = [namespaceDescription, childDescription]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function translateInputItem(
  value: unknown,
  messages: DeepSeekChatMessage[],
  toolMap: Map<string, ToolBridgeDescriptor>,
  context: ResponsesTranslationContext,
): void {
  const item = asRecord(value);
  if (!item) throw badRequest("Responses input items must be objects");

  const type = readString(item.type);
  if (type === "message") {
    const role = normalizeMessageRole(item.role);
    const content = extractContentText(item.content);
    messages.push({ role, content });
    return;
  }

  if (type === "function_call" || type === "custom_tool_call") {
    const callId = readString(item.call_id) ?? readString(item.id);
    const name = readString(item.name);
    const namespace = readString(item.namespace);
    if (!callId || !name) {
      throw badRequest(`${type} requires call_id and name`);
    }
    const deepSeekName = namespace ? flattenNamespaceName(namespace, name) : name;
    const rawArguments = type === "function_call"
      ? stringifyArguments(item.arguments)
      : JSON.stringify({ input: stringifyContent(item.input) });

    appendAssistantToolCall(
      messages,
      {
        id: callId,
        type: "function",
        function: { name: deepSeekName, arguments: rawArguments },
      },
      context.reasoningByCallId?.get(callId),
    );
    if (!toolMap.has(deepSeekName)) {
      toolMap.set(deepSeekName, {
        deepSeekName,
        originalName: name,
        ...(namespace ? { originalNamespace: namespace } : {}),
        originalKind: type === "function_call" ? "function" : "custom",
      });
    }
    return;
  }

  if (type === "function_call_output" || type === "custom_tool_call_output") {
    const callId = readString(item.call_id);
    if (!callId) throw badRequest(`${type} requires call_id`);
    messages.push({
      role: "tool",
      tool_call_id: callId,
      content: stringifyContent(item.output),
    });
    return;
  }

  if (type === "reasoning" || type === "additional_tools" || type === "item_reference") {
    return;
  }

  throw new ResponsesBridgeError({
    kind: "unsupported",
    status: 400,
    message: `Unsupported Responses input item type: ${String(type ?? "<missing>")}`,
    data: { type },
  });
}

function appendAssistantToolCall(
  messages: DeepSeekChatMessage[],
  call: DeepSeekToolCall,
  reasoningContent: string | undefined,
): void {
  const previous = messages.at(-1);
  if (previous?.role === "assistant" && previous.tool_calls) {
    previous.tool_calls.push(call);
    if (!previous.reasoning_content && reasoningContent) {
      previous.reasoning_content = reasoningContent;
    }
    return;
  }
  messages.push({
    role: "assistant",
    content: null,
    ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
    tool_calls: [call],
  });
}

function normalizeMessageRole(value: unknown): "system" | "user" | "assistant" {
  if (value === "developer" || value === "system") return "system";
  if (value === "user") return "user";
  if (value === "assistant") return "assistant";
  throw badRequest(`Unsupported Responses message role: ${String(value)}`);
}

function extractContentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return stringifyContent(value);

  const parts: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      parts.push(entry);
      continue;
    }
    const part = asRecord(entry);
    if (!part) continue;
    if (
      part.type === "input_text"
      || part.type === "output_text"
      || part.type === "text"
    ) {
      const text = readString(part.text);
      if (text) parts.push(text);
      continue;
    }
    if (part.type === "input_image" || part.type === "input_file") {
      throw new ResponsesBridgeError({
        kind: "unsupported",
        status: 400,
        message: `Bridge 2B.1 does not support ${String(part.type)}`,
      });
    }
  }
  return parts.join("\n");
}

function stringifyArguments(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value ?? {});
}

function stringifyContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
}

function requireToolName(value: unknown, type: string): string {
  const name = readString(value);
  if (!name || !TOOL_NAME_PATTERN.test(name)) {
    throw badRequest(`${type} tool name must match ${TOOL_NAME_PATTERN.source}`);
  }
  return name;
}

function badRequest(message: string): ResponsesBridgeError {
  return new ResponsesBridgeError({
    kind: "bad_request",
    status: 400,
    message,
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
