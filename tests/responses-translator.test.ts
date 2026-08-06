import { describe, expect, it } from "vitest";
import {
  parseResponsesRequest,
  translateResponsesRequest,
} from "../src/agent/bridge/responses-translator.js";

describe("Responses request translation", () => {
  it("translates instructions and text input into DeepSeek messages", () => {
    const request = parseResponsesRequest({
      model: "ignored-by-bridge",
      instructions: "system rules",
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      }],
      stream: true,
    });

    const translated = translateResponsesRequest(request, "deepseek-v4-flash");
    expect(translated.model).toBe("deepseek-v4-flash");
    expect(translated.messages).toEqual([
      { role: "system", content: "system rules" },
      { role: "user", content: "hello" },
    ]);
  });

  it("maps custom Responses tools to function tools while preserving return kind", () => {
    const request = parseResponsesRequest({
      model: "deepseek-v4-flash",
      input: "run a command",
      tools: [{
        type: "custom",
        name: "shell",
        description: "Run shell input",
      }],
    });

    const translated = translateResponsesRequest(request, "deepseek-v4-flash");
    expect(translated.tools[0]).toMatchObject({
      type: "function",
      function: {
        name: "shell",
        parameters: {
          type: "object",
          required: ["input"],
        },
      },
    });
    expect(translated.toolMap.get("shell")).toMatchObject({
      originalName: "shell",
      originalKind: "custom",
    });
  });

  it("flattens Codex namespace tools into DeepSeek function tools", () => {
    const request = parseResponsesRequest({
      model: "deepseek-v4-flash",
      input: "inspect the screen",
      tools: [{
        type: "namespace",
        name: "mcp__peekaboo__",
        description: "Peekaboo MCP tools",
        tools: [{
          type: "function",
          name: "screenshot",
          description: "Capture the current screen",
          parameters: {
            type: "object",
            properties: {
              app: { type: "string" },
            },
          },
        }],
      }],
    });

    const translated = translateResponsesRequest(request, "deepseek-v4-flash");
    expect(translated.tools).toContainEqual({
      type: "function",
      function: {
        name: "mcp__peekaboo__screenshot",
        description: "Peekaboo MCP tools\n\nCapture the current screen",
        parameters: {
          type: "object",
          properties: {
            app: { type: "string" },
          },
        },
      },
    });
    expect(translated.toolMap.get("mcp__peekaboo__screenshot")).toEqual({
      deepSeekName: "mcp__peekaboo__screenshot",
      originalName: "mcp__peekaboo__screenshot",
      originalKind: "function",
    });
  });

  it("supports namespace child inputSchema from Codex dynamic tools", () => {
    const request = parseResponsesRequest({
      model: "deepseek-v4-flash",
      input: "lookup a ticket",
      tools: [{
        type: "namespace",
        name: "tickets",
        tools: [{
          type: "function",
          name: "lookup_ticket",
          inputSchema: {
            type: "object",
            required: ["id"],
            properties: {
              id: { type: "string" },
            },
          },
        }],
      }],
    });

    const translated = translateResponsesRequest(request, "deepseek-v4-flash");
    expect(translated.tools[0]).toMatchObject({
      function: {
        name: "tickets__lookup_ticket",
        parameters: {
          type: "object",
          required: ["id"],
        },
      },
    });
  });

  it("translates prior function calls and outputs into chat history", () => {
    const request = parseResponsesRequest({
      model: "deepseek-v4-flash",
      input: [
        {
          type: "function_call",
          call_id: "call_1",
          name: "lookup",
          arguments: "{\"id\":1}",
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: "found",
        },
        {
          type: "message",
          role: "user",
          content: "continue",
        },
      ],
    });

    const translated = translateResponsesRequest(request, "deepseek-v4-flash");
    expect(translated.messages).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "lookup", arguments: "{\"id\":1}" },
        }],
      },
      { role: "tool", tool_call_id: "call_1", content: "found" },
      { role: "user", content: "continue" },
    ]);
  });

  it("restores cached DeepSeek reasoning for a returned tool call", () => {
    const request = parseResponsesRequest({
      model: "deepseek-v4-flash",
      input: [
        {
          type: "function_call",
          call_id: "call_reasoning",
          name: "lookup",
          arguments: "{\"id\":1}",
        },
        {
          type: "function_call_output",
          call_id: "call_reasoning",
          output: "found",
        },
      ],
    });

    const translated = translateResponsesRequest(
      request,
      "deepseek-v4-flash",
      { reasoningByCallId: new Map([["call_reasoning", "private reasoning"]]) },
    );

    expect(translated.messages[0]).toMatchObject({
      role: "assistant",
      reasoning_content: "private reasoning",
      tool_calls: [{ id: "call_reasoning" }],
    });
  });

});
