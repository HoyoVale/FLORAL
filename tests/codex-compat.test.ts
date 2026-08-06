import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  captureCodexResponsesRequest,
  parseCodexCompatibilityFixture,
  verifyCodexCompatibilityFixture,
} from "../src/agent/bridge/responses-compat.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = join(repositoryRoot, "tests", "fixtures", "codex-responses");

describe("Codex Responses compatibility fixtures", () => {
  it("replays every committed fixture through the current translator", async () => {
    const files = (await readdir(fixtureRoot))
      .filter((name) => name.endsWith(".json"))
      .sort();

    expect(files).toHaveLength(3);
    for (const file of files) {
      const fixture = parseCodexCompatibilityFixture(
        JSON.parse(await readFile(join(fixtureRoot, file), "utf8")) as unknown,
      );
      expect(() => verifyCodexCompatibilityFixture(fixture)).not.toThrow();
    }
  });

  it("redacts request content, credentials, paths, and tool arguments", () => {
    const capture = captureCodexResponsesRequest({
      model: "deepseek-v4-flash",
      instructions: "private system prompt",
      input: [{
        type: "function_call",
        call_id: "call-secret-123",
        namespace: "mcp__floral_search__",
        name: "searxng_web_search",
        arguments: JSON.stringify({
          query: "private query",
          token: "very-secret-token",
          cwd: "/Users/private/project",
        }),
      }],
      tools: [{
        type: "namespace",
        name: "mcp__floral_search__",
        tools: [{
          type: "function",
          name: "searxng_web_search",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        }],
      }],
      api_key: "provider-secret",
      metadata: {
        local_path: "/Volumes/WORK_1TB/FLORAL",
        session_token: "session-secret",
        name: "private person name",
        type: "profile",
      },
    });

    const serialized = JSON.stringify(capture);
    expect(serialized).not.toContain("private system prompt");
    expect(serialized).not.toContain("private query");
    expect(serialized).not.toContain("very-secret-token");
    expect(serialized).not.toContain("/Users/private/project");
    expect(serialized).not.toContain("provider-secret");
    expect(serialized).not.toContain("/Volumes/WORK_1TB/FLORAL");
    expect(serialized).not.toContain("session-secret");
    expect(serialized).not.toContain("private person name");
    expect(serialized).toContain("mcp__floral_search__");
    expect(serialized).toContain("searxng_web_search");
    expect(serialized).toContain('"required":["query"]');
    expect(capture.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("produces the same structural fingerprint for different private content", () => {
    const first = captureCodexResponsesRequest({
      model: "model-a",
      input: [{
        type: "message",
        role: "user",
        id: "message-a",
        content: [{ type: "input_text", text: "first private prompt" }],
      }],
      metadata: { token: "token-a" },
    });
    const second = captureCodexResponsesRequest({
      model: "model-b",
      input: [{
        type: "message",
        role: "user",
        id: "message-b",
        content: [{ type: "input_text", text: "second private prompt" }],
      }],
      metadata: { token: "token-b" },
    });

    expect(second.request).toEqual(first.request);
    expect(second.fingerprint).toBe(first.fingerprint);
  });

  it("keeps unknown fields as sanitized shape without changing translation", () => {
    const capture = captureCodexResponsesRequest({
      model: "deepseek-v4-flash",
      input: "private text",
      stream: true,
      future_protocol_field: {
        nested_text: "private future value",
        enabled: true,
        threshold: 3,
      },
    });
    const request = capture.request as Record<string, unknown>;
    expect(request.future_protocol_field).toEqual({
      nested_text: "<string>",
      enabled: true,
      threshold: 3,
    });
  });
});
