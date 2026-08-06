import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ResponsesBridgeServer } from "../src/agent/bridge/responses-bridge-server.js";

const servers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("ResponsesBridgeServer", () => {
  it("translates DeepSeek text SSE into Responses SSE", async () => {
    const fake = await startFakeDeepSeek((request, response) => {
      expect(request.url).toBe("/chat/completions");
      expect(request.headers.authorization).toBe("Bearer deepseek-test-key");
      sendSse(response, [
        {
          id: "chat_1",
          model: "deepseek-v4-flash",
          choices: [{ delta: { role: "assistant", content: "FLORAL_" }, finish_reason: null }],
        },
        {
          id: "chat_1",
          model: "deepseek-v4-flash",
          choices: [{ delta: { content: "BRIDGE_OK" }, finish_reason: "stop" }],
        },
        {
          id: "chat_1",
          model: "deepseek-v4-flash",
          choices: [],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        },
      ]);
    });

    const bridge = await startBridge(fake.baseUrl);
    const response = await fetch(`${bridge.baseUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer bridge-test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        input: "probe",
        stream: true,
      }),
    });

    expect(response.status).toBe(200);
    const events = parseEvents(await response.text());
    const text = events
      .filter((event) => event.type === "response.output_text.delta")
      .map((event) => event.delta)
      .join("");
    expect(text).toBe("FLORAL_BRIDGE_OK");
    expect(events.some((event) => event.type === "response.completed")).toBe(true);
  });

  it("converts mapped custom tool calls back to Responses custom_tool_call", async () => {
    const fake = await startFakeDeepSeek((_request, response) => {
      sendSse(response, [
        {
          id: "chat_2",
          model: "deepseek-v4-flash",
          choices: [{
            delta: {
              role: "assistant",
              tool_calls: [{
                index: 0,
                id: "call_shell",
                type: "function",
                function: { name: "shell", arguments: "{\"input\":\"pwd\"}" },
              }],
            },
            finish_reason: "tool_calls",
          }],
        },
      ]);
    });

    const bridge = await startBridge(fake.baseUrl);
    const response = await fetch(`${bridge.baseUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer bridge-test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        input: "run pwd",
        tools: [{ type: "custom", name: "shell" }],
        stream: true,
      }),
    });

    const events = parseEvents(await response.text());
    const done = events.find((event) =>
      event.type === "response.output_item.done"
      && typeof event.item === "object"
      && event.item !== null
      && (event.item as Record<string, unknown>).type === "custom_tool_call"
    );
    expect(done?.item).toMatchObject({
      type: "custom_tool_call",
      call_id: "call_shell",
      name: "shell",
      input: "pwd",
    });
  });

  it("rejects missing local bridge authentication", async () => {
    const fake = await startFakeDeepSeek((_request, response) => {
      response.statusCode = 500;
      response.end();
    });
    const bridge = await startBridge(fake.baseUrl);

    const response = await fetch(`${bridge.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "deepseek-v4-flash", input: "probe" }),
    });

    expect(response.status).toBe(401);
  });

  it("forces one named tool once and restores thinking context for the tool result", async () => {
    const upstreamBodies: Record<string, any>[] = [];
    let requestCount = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      upstreamBodies.push(JSON.parse(String(init?.body)) as Record<string, any>);
      requestCount += 1;

      if (requestCount === 1) {
        return new Response([
          `data: ${JSON.stringify({
            id: "chat_tool_1",
            model: "deepseek-v4-flash",
            choices: [{
              delta: {
                reasoning_content: "search before answering",
                tool_calls: [{
                  index: 0,
                  id: "call_search",
                  type: "function",
                  function: {
                    name: "mcp__floral_search__searxng_web_search",
                    arguments: "{\"query\":\"SearXNG Search API\"}",
                  },
                }],
              },
              finish_reason: "tool_calls",
            }],
          })}`,
          "data: [DONE]",
          "",
        ].join("\n\n"), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }

      return new Response([
        `data: ${JSON.stringify({
          id: "chat_tool_2",
          model: "deepseek-v4-flash",
          choices: [{
            delta: { content: "FLORAL_WEB_SEARCH_OK" },
            finish_reason: "stop",
          }],
        })}`,
        "data: [DONE]",
        "",
      ].join("\n\n"), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };

    const bridgeServer = new ResponsesBridgeServer({
      host: "127.0.0.1",
      port: 0,
      token: "bridge-test-token",
      maxBodyBytes: 1024 * 1024,
      deepSeek: {
        apiKey: "deepseek-test-key",
        baseUrl: "https://deepseek.invalid",
        model: "deepseek-v4-flash",
        requestTimeoutMs: 2_000,
        thinking: "disabled",
        reasoningEffort: "high",
        forceToolNameOnce: "mcp__floral_search__searxng_web_search",
        fetchImpl,
      },
    });
    const bridge = await bridgeServer.start();
    servers.push({ close: () => bridgeServer.stop() });

    const tools = [{
      type: "namespace",
      name: "mcp__floral_search__",
      tools: [{
        type: "function",
        name: "searxng_web_search",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      }],
    }];

    const first = await fetch(`${bridge.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer bridge-test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        input: "search",
        tools,
        stream: true,
      }),
    });
    await first.text();

    const second = await fetch(`${bridge.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer bridge-test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        input: [
          {
            type: "function_call",
            call_id: "call_search",
            name: "mcp__floral_search__searxng_web_search",
            arguments: "{\"query\":\"SearXNG Search API\"}",
          },
          {
            type: "function_call_output",
            call_id: "call_search",
            output: "search result",
          },
        ],
        tools,
        stream: true,
      }),
    });
    await second.text();

    expect(upstreamBodies[0]?.tool_choice).toEqual({
      type: "function",
      function: { name: "mcp__floral_search__searxng_web_search" },
    });
    expect(upstreamBodies[1]?.tool_choice).toBe("auto");
    expect(upstreamBodies[1]?.messages?.[0]).toMatchObject({
      role: "assistant",
      reasoning_content: "search before answering",
      tool_calls: [{ id: "call_search" }],
    });
  });

});

async function startBridge(deepSeekBaseUrl: string): Promise<{ baseUrl: string }> {
  const bridge = new ResponsesBridgeServer({
    host: "127.0.0.1",
    port: 0,
    token: "bridge-test-token",
    maxBodyBytes: 1024 * 1024,
    deepSeek: {
      apiKey: "deepseek-test-key",
      baseUrl: deepSeekBaseUrl,
      model: "deepseek-v4-flash",
      requestTimeoutMs: 2_000,
      thinking: "enabled",
      reasoningEffort: "high",
    },
  });
  const address = await bridge.start();
  servers.push({ close: () => bridge.stop() });
  return { baseUrl: address.baseUrl };
}

async function startFakeDeepSeek(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ baseUrl: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  servers.push({
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  });
  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}` };
}

function sendSse(response: ServerResponse, chunks: unknown[]): void {
  response.statusCode = 200;
  response.setHeader("content-type", "text/event-stream");
  for (const chunk of chunks) {
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  response.end("data: [DONE]\n\n");
}

function parseEvents(text: string): Record<string, any>[] {
  const events: Record<string, any>[] = [];
  for (const frame of text.replace(/\r\n/g, "\n").split("\n\n")) {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    events.push(JSON.parse(data));
  }
  return events;
}
