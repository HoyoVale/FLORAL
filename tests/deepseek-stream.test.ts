import { describe, expect, it } from "vitest";
import type { TranslatedDeepSeekRequest } from "../src/agent/bridge/bridge-types.js";
import { streamDeepSeekChat } from "../src/agent/bridge/deepseek-stream.js";

const request: TranslatedDeepSeekRequest = {
  model: "deepseek-v4-flash",
  messages: [{ role: "user", content: "probe" }],
  tools: [],
  toolMap: new Map(),
  parallelToolCalls: false,
};

function options(fetchImpl: typeof fetch, requestTimeoutMs = 1_000) {
  return {
    apiKey: "test-secret",
    baseUrl: "https://deepseek.invalid",
    requestTimeoutMs,
    thinking: "disabled" as const,
    reasoningEffort: "high" as const,
    fetchImpl,
  };
}

function sse(text: string, status = 200, headers?: Record<string, string>): Response {
  return new Response(text, {
    status,
    headers: { "content-type": "text/event-stream", ...headers },
  });
}

describe("DeepSeek streaming protocol", () => {
  it("uses requestTimeoutMs as an idle timeout instead of a total stream lifetime cap", async () => {
    const encoder = new TextEncoder();
    const fetchImpl: typeof fetch = async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          setTimeout(() => {
            controller.enqueue(encoder.encode(
              `data: ${JSON.stringify({
                model: "deepseek-v4-flash",
                choices: [{ delta: { reasoning_content: "still working" }, finish_reason: null }],
              })}

`,
            ));
          }, 100);
          setTimeout(() => {
            controller.enqueue(encoder.encode(
              `data: ${JSON.stringify({
                model: "deepseek-v4-flash",
                choices: [{ delta: { content: "done" }, finish_reason: "stop" }],
              })}

`,
            ));
          }, 200);
          setTimeout(() => {
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          }, 300);
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };

    const stream = streamDeepSeekChat(request, options(fetchImpl, 180));
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);

    expect(chunks.some((chunk) => chunk.reasoningDelta === "still working")).toBe(true);
    expect(chunks.some((chunk) => chunk.contentDelta === "done")).toBe(true);
  });

  it("rejects malformed SSE JSON as a non-retryable protocol error", async () => {
    const stream = streamDeepSeekChat(
      request,
      options(async () => sse("data: not-json\n\ndata: [DONE]\n\n")),
    );
    await expect(stream.next()).rejects.toMatchObject({
      kind: "protocol",
      retryable: false,
    });
  });

  it("rejects a stream that ends without the terminal DONE marker", async () => {
    const stream = streamDeepSeekChat(
      request,
      options(async () => sse(
        `data: ${JSON.stringify({
          model: "deepseek-v4-flash",
          choices: [{ delta: { content: "partial" }, finish_reason: null }],
        })}\n\n`,
      )),
    );
    await expect(stream.next()).resolves.toMatchObject({
      done: false,
      value: { contentDelta: "partial" },
    });
    await expect(stream.next()).rejects.toMatchObject({ kind: "protocol" });
  });

  it("classifies parent cancellation separately from timeout", async () => {
    const controller = new AbortController();
    const fetchImpl: typeof fetch = async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    const stream = streamDeepSeekChat(request, options(fetchImpl), controller.signal);
    const next = stream.next();
    controller.abort();
    await expect(next).rejects.toMatchObject({
      kind: "cancelled",
      retryable: false,
    });
  });

  it("classifies an internal stalled request as timeout", async () => {
    const fetchImpl: typeof fetch = async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
    });
    const stream = streamDeepSeekChat(request, options(fetchImpl, 10));
    await expect(stream.next()).rejects.toMatchObject({
      kind: "timeout",
      retryable: true,
    });
  });

  it("parses Retry-After metadata for a rate-limit response", async () => {
    const stream = streamDeepSeekChat(
      request,
      options(async () => new Response(
        JSON.stringify({ error: { message: "slow down" } }),
        {
          status: 429,
          headers: {
            "content-type": "application/json",
            "retry-after": "2",
          },
        },
      )),
    );
    await expect(stream.next()).rejects.toMatchObject({
      kind: "rate_limit",
      status: 429,
      retryAfterMs: 2_000,
    });
  });
  it("captures DeepSeek cache and reasoning usage needed for billing guards", async () => {
    const stream = streamDeepSeekChat(
      request,
      options(async () => sse(
        `data: ${JSON.stringify({
          model: "deepseek-v4-flash",
          choices: [],
          usage: {
            prompt_tokens: 100,
            prompt_cache_hit_tokens: 80,
            prompt_cache_miss_tokens: 20,
            completion_tokens: 40,
            completion_tokens_details: { reasoning_tokens: 30 },
            total_tokens: 140,
          },
        })}\n\ndata: [DONE]\n\n`,
      )),
    );
    await expect(stream.next()).resolves.toMatchObject({
      done: false,
      value: {
        usage: {
          promptTokens: 100,
          promptCacheHitTokens: 80,
          promptCacheMissTokens: 20,
          completionTokens: 40,
          reasoningTokens: 30,
          totalTokens: 140,
        },
      },
    });
  });

});
