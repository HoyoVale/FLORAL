import { ResponsesBridgeServer } from "./responses-bridge-server.js";
import type { AppEnv } from "../../config/env.js";
import type { CapturedCodexResponsesRequest } from "./responses-compat.js";
import type { DeepSeekCostGuard } from "../../runtime/cost/deepseek-cost-guard.js";
import type { ProviderActivityGate } from "../../runtime/cost/provider-activity-gate.js";

export interface ResponsesBridgeOverrides {
  thinking?: "enabled" | "disabled" | undefined;
  forceToolNameOnce?: string | undefined;
  forceToolWhenInputContains?: string | undefined;
  onForcedToolSelected?: ((name: string) => void) | undefined;
  onCompatibilityRequest?: (
    (capture: CapturedCodexResponsesRequest) => void
  ) | undefined;
  onCompatibilityCaptureError?: ((error: Error) => void) | undefined;
  costGuard?: DeepSeekCostGuard | undefined;
  activityGate?: ProviderActivityGate | undefined;
}

export function createResponsesBridge(
  env: AppEnv,
  token: string,
  port = env.FLORAL_BRIDGE_PORT,
  overrides: ResponsesBridgeOverrides = {},
): ResponsesBridgeServer {
  if (!env.DEEPSEEK_API_KEY) {
    throw new Error("DEEPSEEK_API_KEY is required to start the Responses bridge");
  }
  return new ResponsesBridgeServer({
    host: env.FLORAL_BRIDGE_HOST,
    port,
    token,
    maxBodyBytes: env.FLORAL_BRIDGE_MAX_BODY_BYTES,
    capacity: {
      maxConcurrentRequests: env.FLORAL_BRIDGE_MAX_CONCURRENT_REQUESTS,
      maxQueuedRequests: env.FLORAL_BRIDGE_MAX_QUEUED_REQUESTS,
      queueTimeoutMs: env.FLORAL_BRIDGE_QUEUE_TIMEOUT_MS,
    },
    ...(overrides.costGuard ? { costGuard: overrides.costGuard } : {}),
    ...(overrides.activityGate ? { activityGate: overrides.activityGate } : {}),
    ...(overrides.onCompatibilityRequest
      ? {
          compatibilityCapture: {
            onRequest: overrides.onCompatibilityRequest,
            ...(overrides.onCompatibilityCaptureError
              ? { onError: overrides.onCompatibilityCaptureError }
              : {}),
          },
        }
      : {}),
    deepSeek: {
      apiKey: env.DEEPSEEK_API_KEY,
      baseUrl: env.DEEPSEEK_BASE_URL,
      model: env.DEEPSEEK_MODEL,
      requestTimeoutMs: env.DEEPSEEK_REQUEST_TIMEOUT_MS,
      thinking: overrides.thinking ?? env.DEEPSEEK_THINKING,
      reasoningEffort: env.DEEPSEEK_REASONING_EFFORT,
      retry: {
        maxAttempts: env.DEEPSEEK_PRESTREAM_MAX_ATTEMPTS,
        baseDelayMs: env.DEEPSEEK_RETRY_BASE_DELAY_MS,
        maxDelayMs: env.DEEPSEEK_RETRY_MAX_DELAY_MS,
      },
      ...(overrides.forceToolNameOnce
        ? { forceToolNameOnce: overrides.forceToolNameOnce }
        : {}),
      ...(overrides.forceToolWhenInputContains
        ? { forceToolWhenInputContains: overrides.forceToolWhenInputContains }
        : {}),
      ...(overrides.onForcedToolSelected
        ? { onForcedToolSelected: overrides.onForcedToolSelected }
        : {}),
    },
  });
}
