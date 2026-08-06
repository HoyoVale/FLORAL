import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import type {
  DeepSeekStreamChunk,
  ToolBridgeDescriptor,
} from "./bridge-types.js";

interface AccumulatedToolCall {
  index: number;
  id: string;
  name: string;
  arguments: string;
}

export interface CompletedBridgeToolCall {
  callId: string;
  name: string;
  reasoningContent: string | undefined;
}

export class ResponsesSseWriter {
  readonly #response: ServerResponse;
  readonly #responseId = `resp_${randomUUID().replaceAll("-", "")}`;
  readonly #model: string;
  readonly #toolMap: Map<string, ToolBridgeDescriptor>;
  readonly #onToolCallCompleted: ((call: CompletedBridgeToolCall) => void) | undefined;
  readonly #createdAt = Math.floor(Date.now() / 1_000);
  readonly #output: Record<string, unknown>[] = [];
  readonly #toolCalls = new Map<number, AccumulatedToolCall>();
  #sequence = 0;
  #messageId: string | undefined;
  #text = "";
  #reasoning = "";
  #usage: DeepSeekStreamChunk["usage"];
  #ended = false;

  constructor(
    response: ServerResponse,
    model: string,
    toolMap: Map<string, ToolBridgeDescriptor>,
    onToolCallCompleted?: (call: CompletedBridgeToolCall) => void,
  ) {
    this.#response = response;
    this.#model = model;
    this.#toolMap = toolMap;
    this.#onToolCallCompleted = onToolCallCompleted;
  }

  start(): void {
    this.#send("response.created", {
      type: "response.created",
      response: this.#responseObject("in_progress"),
    });
  }

  consume(chunk: DeepSeekStreamChunk): void {
    if (chunk.usage) this.#usage = chunk.usage;

    if (chunk.reasoningDelta) {
      this.#reasoning += chunk.reasoningDelta;
    }

    if (chunk.contentDelta) {
      this.#ensureMessage();
      this.#text += chunk.contentDelta;
      this.#send("response.output_text.delta", {
        type: "response.output_text.delta",
        item_id: this.#messageId,
        output_index: 0,
        content_index: 0,
        delta: chunk.contentDelta,
        logprobs: [],
      });
    }

    for (const delta of chunk.toolCallDeltas) {
      const current = this.#toolCalls.get(delta.index) ?? {
        index: delta.index,
        id: delta.id ?? `call_${randomUUID().replaceAll("-", "")}`,
        name: "",
        arguments: "",
      };
      if (delta.id) current.id = delta.id;
      if (delta.name) current.name += delta.name;
      if (delta.arguments) current.arguments += delta.arguments;
      this.#toolCalls.set(delta.index, current);
    }
  }

  complete(): void {
    if (this.#ended) return;

    if (!this.#messageId && this.#toolCalls.size === 0) {
      this.#ensureMessage();
    }

    if (this.#messageId) this.#finishMessage();

    let outputIndex = this.#output.length;
    const calls = [...this.#toolCalls.values()].sort((a, b) => a.index - b.index);
    for (const call of calls) {
      this.#finishToolCall(call, outputIndex);
      this.#onToolCallCompleted?.({
        callId: call.id,
        name: call.name,
        reasoningContent: this.#reasoning || undefined,
      });
      outputIndex += 1;
    }

    this.#send("response.completed", {
      type: "response.completed",
      response: this.#responseObject("completed"),
    });
    this.#response.write("data: [DONE]\n\n");
    this.#response.end();
    this.#ended = true;
  }

  fail(code: string, message: string): void {
    if (this.#ended) return;
    this.#send("error", {
      type: "error",
      code,
      message,
      param: null,
    });
    this.#response.end();
    this.#ended = true;
  }

  #finishMessage(): void {
    const messageId = this.#messageId;
    if (!messageId) return;
    const contentPart = {
      type: "output_text",
      annotations: [],
      logprobs: [],
      text: this.#text,
    };
    const item = {
      id: messageId,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [contentPart],
    };
    this.#send("response.output_text.done", {
      type: "response.output_text.done",
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      text: this.#text,
      logprobs: [],
    });
    this.#send("response.content_part.done", {
      type: "response.content_part.done",
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      part: contentPart,
    });
    this.#send("response.output_item.done", {
      type: "response.output_item.done",
      output_index: 0,
      item,
    });
    this.#output.push(item);
  }

  #finishToolCall(call: AccumulatedToolCall, outputIndex: number): void {
    const descriptor = this.#toolMap.get(call.name) ?? {
      deepSeekName: call.name,
      originalName: call.name,
      originalKind: "function" as const,
    };
    const itemId = `fc_${randomUUID().replaceAll("-", "")}`;

    if (descriptor.originalKind === "custom") {
      const input = customInputFromArguments(call.arguments);
      const item = {
        id: itemId,
        type: "custom_tool_call",
        status: "completed",
        call_id: call.id,
        ...(descriptor.originalNamespace
        ? { namespace: descriptor.originalNamespace }
        : {}),
      name: descriptor.originalName,
        input,
      };
      this.#send("response.output_item.added", {
        type: "response.output_item.added",
        output_index: outputIndex,
        item: { ...item, status: "in_progress", input: "" },
      });
      if (input) {
        this.#send("response.custom_tool_call_input.delta", {
          type: "response.custom_tool_call_input.delta",
          output_index: outputIndex,
          item_id: itemId,
          delta: input,
        });
      }
      this.#send("response.custom_tool_call_input.done", {
        type: "response.custom_tool_call_input.done",
        output_index: outputIndex,
        item_id: itemId,
        input,
      });
      this.#send("response.output_item.done", {
        type: "response.output_item.done",
        output_index: outputIndex,
        item,
      });
      this.#output.push(item);
      return;
    }

    const item = {
      id: itemId,
      type: "function_call",
      status: "completed",
      call_id: call.id,
      ...(descriptor.originalNamespace
        ? { namespace: descriptor.originalNamespace }
        : {}),
      name: descriptor.originalName,
      arguments: call.arguments,
    };
    this.#send("response.output_item.added", {
      type: "response.output_item.added",
      output_index: outputIndex,
      item: { ...item, status: "in_progress", arguments: "" },
    });
    if (call.arguments) {
      this.#send("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        output_index: outputIndex,
        item_id: itemId,
        delta: call.arguments,
      });
    }
    this.#send("response.function_call_arguments.done", {
      type: "response.function_call_arguments.done",
      output_index: outputIndex,
      item_id: itemId,
      ...(descriptor.originalNamespace
        ? { namespace: descriptor.originalNamespace }
        : {}),
      name: descriptor.originalName,
      arguments: call.arguments,
    });
    this.#send("response.output_item.done", {
      type: "response.output_item.done",
      output_index: outputIndex,
      item,
    });
    this.#output.push(item);
  }

  #ensureMessage(): void {
    if (this.#messageId) return;
    this.#messageId = `msg_${randomUUID().replaceAll("-", "")}`;
    const item = {
      id: this.#messageId,
      type: "message",
      status: "in_progress",
      role: "assistant",
      content: [],
    };
    this.#send("response.output_item.added", {
      type: "response.output_item.added",
      output_index: 0,
      item,
    });
    this.#send("response.content_part.added", {
      type: "response.content_part.added",
      item_id: this.#messageId,
      output_index: 0,
      content_index: 0,
      part: {
        type: "output_text",
        annotations: [],
        logprobs: [],
        text: "",
      },
    });
  }

  #responseObject(status: "in_progress" | "completed"): Record<string, unknown> {
    return {
      id: this.#responseId,
      object: "response",
      created_at: this.#createdAt,
      status,
      error: null,
      incomplete_details: null,
      instructions: null,
      model: this.#model,
      output: status === "completed" ? this.#output : [],
      parallel_tool_calls: true,
      previous_response_id: null,
      reasoning: { effort: null, summary: null },
      store: false,
      temperature: null,
      text: { format: { type: "text" } },
      tool_choice: "auto",
      tools: [],
      top_p: null,
      truncation: "disabled",
      usage: status === "completed"
        ? {
            input_tokens: this.#usage?.promptTokens ?? 0,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: this.#usage?.completionTokens ?? 0,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: this.#usage?.totalTokens ?? 0,
          }
        : null,
    };
  }

  #send(event: string, data: Record<string, unknown>): void {
    this.#sequence += 1;
    const payload = { ...data, sequence_number: this.#sequence };
    this.#response.write(`event: ${event}\n`);
    this.#response.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
}

function customInputFromArguments(argumentsText: string): string {
  try {
    const parsed = JSON.parse(argumentsText) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      const input = (parsed as Record<string, unknown>).input;
      if (typeof input === "string") return input;
    }
  } catch {
    // Keep the raw argument string.
  }
  return argumentsText;
}
