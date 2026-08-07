import { DeepSeekClient } from "../src/agent/provider/deepseek-client.js";
import { ModelProviderError } from "../src/agent/provider/provider-errors.js";
import { loadEnv } from "../src/config/env.js";
import { loadProjectEnv } from "../src/config/load-project-env.js";
import { createProjectDeepSeekCostGuard } from "../src/runtime/cost/cost-guard-factory.js";

loadProjectEnv();
const env = loadEnv();

console.log("probe.provider=deepseek");
console.log(`probe.base_url=${env.DEEPSEEK_BASE_URL}`);
console.log(`probe.model=${env.DEEPSEEK_MODEL}`);
console.log(`probe.thinking=${env.DEEPSEEK_THINKING}`);
console.log(`probe.reasoning_effort=${env.DEEPSEEK_REASONING_EFFORT}`);

if (!env.DEEPSEEK_API_KEY) {
  console.log("probe.key=missing");
  console.log("probe.result=configuration-required");
  process.exitCode = 2;
} else {
  console.log("probe.key=present");

  const client = new DeepSeekClient({
    apiKey: env.DEEPSEEK_API_KEY,
    baseUrl: env.DEEPSEEK_BASE_URL,
    model: env.DEEPSEEK_MODEL,
    requestTimeoutMs: env.DEEPSEEK_REQUEST_TIMEOUT_MS,
    thinking: env.DEEPSEEK_THINKING,
    reasoningEffort: env.DEEPSEEK_REASONING_EFFORT,
  });

  const completionRequest = {
    messages: [
      {
        role: "system" as const,
        content: "You are a connectivity probe. Follow the user's output constraint exactly.",
      },
      { role: "user" as const, content: "Reply with exactly: FLORAL_DEEPSEEK_OK" },
    ],
    maxTokens: 64,
  };
  const costGuard = await createProjectDeepSeekCostGuard(process.cwd(), process.env);
  let lease: Awaited<ReturnType<typeof costGuard.beginAttempt>> | undefined;

  try {
    lease = await costGuard.beginAttempt({
      model: env.DEEPSEEK_MODEL,
      messages: completionRequest.messages,
      tools: [],
      toolMap: new Map(),
      maxTokens: completionRequest.maxTokens,
      parallelToolCalls: false,
    });
    const result = await client.complete(completionRequest);
    await costGuard.completeAttempt(lease, result.usage, "completed");
    lease = undefined;

    console.log(`probe.response_model=${result.model}`);
    console.log(`probe.finish_reason=${result.finishReason ?? "<none>"}`);
    console.log(`probe.text=${JSON.stringify(result.text.trim())}`);

    if (result.text.trim() !== "FLORAL_DEEPSEEK_OK") {
      console.log("probe.result=unexpected-output");
      process.exitCode = 1;
    } else {
      console.log("probe.result=ok");
    }
  } catch (error) {
    if (lease) {
      await costGuard.completeAttempt(lease, undefined, "failed").catch(() => undefined);
    }
    const wrapped = error instanceof ModelProviderError
      ? error
      : new ModelProviderError({
          kind: "protocol",
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
          cause: error,
        });

    console.log(`probe.error.kind=${wrapped.kind}`);
    console.log(`probe.error.retryable=${wrapped.retryable}`);
    console.log(`probe.error.status=${wrapped.status ?? "<none>"}`);
    console.log(`probe.error.message=${wrapped.message}`);
    console.log("probe.result=failed");
    process.exitCode = 1;
  }
}
