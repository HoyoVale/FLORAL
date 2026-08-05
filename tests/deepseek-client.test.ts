import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DeepSeekClient } from "../src/agent/provider/deepseek-client.js";
import { ModelProviderError } from "../src/agent/provider/provider-errors.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

describe("DeepSeekClient", () => {
  it("sends the official chat-completions shape and parses text", async () => {
    const baseUrl = await startServer(async (request, response) => {
      expect(request.url).toBe("/chat/completions");
      expect(request.headers.authorization).toBe("Bearer test-secret");

      const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
      expect(body.model).toBe("deepseek-v4-flash");
      expect(body.stream).toBe(false);
      expect(body.thinking).toEqual({ type: "enabled" });
      expect(body.reasoning_effort).toBe("high");

      respondJson(response, 200, {
        id: "chatcmpl_test",
        model: "deepseek-v4-flash",
        choices: [{
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: "FLORAL_DEEPSEEK_OK" },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      });
    });

    const client = new DeepSeekClient({
      apiKey: "test-secret",
      baseUrl,
      requestTimeoutMs: 1_000,
    });
    const result = await client.complete({
      messages: [{ role: "user", content: "probe" }],
      maxTokens: 64,
    });

    expect(result).toEqual({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      text: "FLORAL_DEEPSEEK_OK",
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
    });
  });

  it("classifies authentication failures and redacts the API key", async () => {
    const baseUrl = await startServer((_request, response) => {
      respondJson(response, 401, {
        error: { message: "invalid key test-secret" },
      });
    });

    const client = new DeepSeekClient({
      apiKey: "test-secret",
      baseUrl,
      requestTimeoutMs: 1_000,
    });

    let caught: unknown;
    try {
      await client.complete({ messages: [{ role: "user", content: "probe" }] });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ModelProviderError);
    expect(caught).toMatchObject({
      kind: "authentication",
      retryable: false,
      status: 401,
    });
    expect((caught as Error).message).not.toContain("test-secret");
    expect((caught as Error).message).toContain("[REDACTED]");
  });

  it("classifies rate limits as retryable", async () => {
    const baseUrl = await startServer((_request, response) => {
      respondJson(response, 429, { error: { message: "too many requests" } });
    });

    const client = new DeepSeekClient({
      apiKey: "test-secret",
      baseUrl,
      requestTimeoutMs: 1_000,
    });

    await expect(
      client.complete({ messages: [{ role: "user", content: "probe" }] }),
    ).rejects.toMatchObject({
      kind: "rate_limit",
      retryable: true,
      status: 429,
    });
  });

  it("aborts stalled requests", async () => {
    const baseUrl = await startServer(() => {
      // Intentionally leave the response open until the client aborts.
    });

    const client = new DeepSeekClient({
      apiKey: "test-secret",
      baseUrl,
      requestTimeoutMs: 50,
    });

    await expect(
      client.complete({ messages: [{ role: "user", content: "probe" }] }),
    ).rejects.toMatchObject({
      kind: "timeout",
      retryable: true,
    });
  });
});

async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
): Promise<string> {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch((error: unknown) => {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  servers.push(server);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function respondJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}
