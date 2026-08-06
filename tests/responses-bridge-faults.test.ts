import { afterEach, describe, expect, it } from "vitest";
import { ResponsesBridgeServer } from "../src/agent/bridge/responses-bridge-server.js";

const bridges: ResponsesBridgeServer[] = [];

afterEach(async () => {
  await Promise.all(bridges.splice(0).map(async (bridge) => {
    try {
      await bridge.stop();
    } catch {
      // A test may already have stopped the bridge.
    }
  }));
});

describe("Responses bridge fault injection", () => {
  it("retries one pre-stream network failure and then succeeds", async () => {
    let attempts = 0;
    const { bridge, baseUrl } = await startBridge(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("connection reset before headers");
      return successSse("RETRY_OK");
    });

    const response = await requestBridge(baseUrl, "retry network");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("RETRY_OK");
    expect(attempts).toBe(2);

    const health = await fetch(`${baseUrl.replace(/\/v1$/, "")}/health`);
    await expect(health.json()).resolves.toMatchObject({
      retry: { maxAttempts: 2, totalRetries: 1 },
    });
    expect(bridge).toBeDefined();
  });

  it("retries one pre-stream rate limit and then succeeds", async () => {
    let attempts = 0;
    const { baseUrl } = await startBridge(async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response(JSON.stringify({ error: { message: "too many requests" } }), {
          status: 429,
          headers: {
            "content-type": "application/json",
            "retry-after": "0",
          },
        });
      }
      return successSse("RATE_LIMIT_RECOVERED");
    });

    const response = await requestBridge(baseUrl, "retry rate limit");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("RATE_LIMIT_RECOVERED");
    expect(attempts).toBe(2);
  });

  it("does not retry provider authentication failures", async () => {
    let attempts = 0;
    const { baseUrl } = await startBridge(async () => {
      attempts += 1;
      return new Response(JSON.stringify({ error: { message: "invalid provider key" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    });

    const response = await requestBridge(baseUrl, "auth failure");
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        type: "provider_error",
        kind: "authentication",
        retryable: false,
      },
    });
    expect(attempts).toBe(1);
  });

  it("does not retry after a text stream has started", async () => {
    let attempts = 0;
    const { baseUrl } = await startBridge(async () => {
      attempts += 1;
      return new Response(
        `data: ${JSON.stringify({
          model: "deepseek-v4-flash",
          choices: [{ delta: { content: "partial" }, finish_reason: null }],
        })}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    });

    const response = await requestBridge(baseUrl, "partial text");
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("partial");
    expect(body).toContain('"type":"error"');
    expect(body).toContain('"code":"protocol"');
    expect(attempts).toBe(1);
  });

  it("does not replay a tool call after the provider stream starts", async () => {
    let attempts = 0;
    const { baseUrl } = await startBridge(async () => {
      attempts += 1;
      return new Response(
        `data: ${JSON.stringify({
          model: "deepseek-v4-flash",
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "call_once",
                type: "function",
                function: { name: "lookup", arguments: "{\"q\":\"x\"}" },
              }],
            },
            finish_reason: null,
          }],
        })}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    });

    const response = await requestBridge(baseUrl, "tool once", [{
      type: "function",
      name: "lookup",
      parameters: { type: "object" },
    }]);
    const body = await response.text();
    expect(body).toContain('"type":"error"');
    expect(body).not.toContain('"type":"function_call"');
    expect(attempts).toBe(1);
  });

  it("propagates client cancellation to the provider request", async () => {
    let signalProviderStarted: (() => void) | undefined;
    const providerStarted = new Promise<void>((resolve) => {
      signalProviderStarted = resolve;
    });
    let signalProviderAborted: (() => void) | undefined;
    const providerAborted = new Promise<void>((resolve) => {
      signalProviderAborted = resolve;
    });

    const { baseUrl } = await startBridge(async (_input, init) => {
      signalProviderStarted?.();
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          signalProviderAborted?.();
          reject(new Error("provider aborted"));
        }, { once: true });
      });
    });

    const controller = new AbortController();
    const request = requestBridge(baseUrl, "cancel me", undefined, controller.signal);
    await providerStarted;
    controller.abort();
    await expect(request).rejects.toBeDefined();
    await providerAborted;
  });

  it("aborts active provider requests when the bridge stops", async () => {
    let signalProviderStarted: (() => void) | undefined;
    const providerStarted = new Promise<void>((resolve) => {
      signalProviderStarted = resolve;
    });
    let signalProviderAborted: (() => void) | undefined;
    const providerAborted = new Promise<void>((resolve) => {
      signalProviderAborted = resolve;
    });

    const { bridge, baseUrl } = await startBridge(async (_input, init) => {
      signalProviderStarted?.();
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          signalProviderAborted?.();
          reject(new Error("bridge stopped"));
        }, { once: true });
      });
    });

    const pending = requestBridge(baseUrl, "stop bridge").catch(() => undefined);
    await providerStarted;
    await bridge.stop();
    await providerAborted;
    await pending;
  });
});

async function startBridge(fetchImpl: typeof fetch): Promise<{
  bridge: ResponsesBridgeServer;
  baseUrl: string;
}> {
  const bridge = new ResponsesBridgeServer({
    host: "127.0.0.1",
    port: 0,
    token: "bridge-test-token",
    maxBodyBytes: 1024 * 1024,
    capacity: {
      maxConcurrentRequests: 1,
      maxQueuedRequests: 1,
      queueTimeoutMs: 500,
    },
    deepSeek: {
      apiKey: "deepseek-test-key",
      baseUrl: "https://deepseek.invalid",
      model: "deepseek-v4-flash",
      requestTimeoutMs: 2_000,
      thinking: "disabled",
      reasoningEffort: "high",
      retry: {
        maxAttempts: 2,
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitterRatio: 0,
      },
      fetchImpl,
    },
  });
  const address = await bridge.start();
  bridges.push(bridge);
  return { bridge, baseUrl: address.baseUrl };
}

async function requestBridge(
  baseUrl: string,
  input: string,
  tools?: unknown[],
  signal?: AbortSignal,
): Promise<Response> {
  return await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: {
      authorization: "Bearer bridge-test-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      input,
      ...(tools ? { tools } : {}),
      stream: true,
    }),
    ...(signal ? { signal } : {}),
  });
}

function successSse(text: string): Response {
  return new Response([
    `data: ${JSON.stringify({
      model: "deepseek-v4-flash",
      choices: [{ delta: { content: text }, finish_reason: "stop" }],
    })}`,
    "data: [DONE]",
    "",
  ].join("\n\n"), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}
