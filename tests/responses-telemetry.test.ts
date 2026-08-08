import { describe, expect, it } from "vitest";
import {
  buildResponsesBridgeRequestTelemetry,
  renderResponsesBridgeTelemetryEvent,
} from "../src/agent/bridge/responses-telemetry.js";
import { translateResponsesRequest } from "../src/agent/bridge/responses-translator.js";
import type { ResponsesBridgeRequest } from "../src/agent/bridge/bridge-types.js";

describe("Responses bridge structural telemetry", () => {
  it("captures model/tool/input shape without logging prompt or memory content", () => {
    const request: ResponsesBridgeRequest = {
      model: "deepseek-v4-flash",
      instructions: "PRIVATE MEMORY INSTRUCTION super-secret-value",
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "PRIVATE USER CONTENT" }],
      }],
      tools: [{
        type: "custom",
        name: "apply_patch",
        description: "PRIVATE TOOL DESCRIPTION",
        format: { type: "text" },
      }],
      parallel_tool_calls: false,
      max_output_tokens: 4096,
    };
    const translated = translateResponsesRequest(request, "deepseek-v4-flash");
    const event = buildResponsesBridgeRequestTelemetry({
      requestId: 7,
      atMs: Date.parse("2026-08-08T19:58:36.000Z"),
      request,
      translated,
    });
    const rendered = renderResponsesBridgeTelemetryEvent(event);

    expect(event).toMatchObject({
      event: "request",
      requestId: 7,
      requestedModel: "deepseek-v4-flash",
      translatedModel: "deepseek-v4-flash",
      instructionsPresent: true,
      inputKind: "array",
      inputItemCount: 1,
      inputTypes: ["message"],
      toolsCount: 1,
      toolNames: ["apply_patch"],
      toolKinds: ["custom"],
      parallelToolCalls: false,
      maxOutputTokens: 4096,
    });
    expect(event.instructionsFingerprint).toMatch(/^sha256:[0-9a-f]{16}$/u);
    expect(event.instructionsBytes).toBeGreaterThan(0);
    expect(rendered).not.toContain("PRIVATE MEMORY INSTRUCTION");
    expect(rendered).not.toContain("super-secret-value");
    expect(rendered).not.toContain("PRIVATE USER CONTENT");
    expect(rendered).not.toContain("PRIVATE TOOL DESCRIPTION");
  });

  it("summarizes namespace tool names without retaining schemas or arguments", () => {
    const request: ResponsesBridgeRequest = {
      model: "deepseek-v4-flash",
      input: "do not log this body",
      tools: [{
        type: "namespace",
        name: "mcp__floral_search__",
        tools: [{
          type: "function",
          name: "searxng_web_search",
          parameters: {
            type: "object",
            properties: { query: { type: "string", description: "SECRET SCHEMA" } },
          },
        }],
      }],
    };
    const translated = translateResponsesRequest(request, "deepseek-v4-flash");
    const event = buildResponsesBridgeRequestTelemetry({
      requestId: 1,
      atMs: 0,
      request,
      translated,
    });
    const rendered = JSON.stringify(event);

    expect(event.toolNames).toContain("mcp__floral_search__searxng_web_search");
    expect(rendered).not.toContain("do not log this body");
    expect(rendered).not.toContain("SECRET SCHEMA");
  });
});
