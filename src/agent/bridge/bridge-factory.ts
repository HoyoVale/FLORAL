import { ResponsesBridgeServer } from "./responses-bridge-server.js";
import type { AppEnv } from "../../config/env.js";

export interface ResponsesBridgeOverrides {
  thinking?: "enabled" | "disabled" | undefined;
  forceToolNameOnce?: string | undefined;
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
    deepSeek: {
      apiKey: env.DEEPSEEK_API_KEY,
      baseUrl: env.DEEPSEEK_BASE_URL,
      model: env.DEEPSEEK_MODEL,
      requestTimeoutMs: env.DEEPSEEK_REQUEST_TIMEOUT_MS,
      thinking: overrides.thinking ?? env.DEEPSEEK_THINKING,
      reasoningEffort: env.DEEPSEEK_REASONING_EFFORT,
      ...(overrides.forceToolNameOnce
        ? { forceToolNameOnce: overrides.forceToolNameOnce }
        : {}),
    },
  });
}
