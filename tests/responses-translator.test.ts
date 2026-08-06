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
});
