import type { EffectiveConfig } from "../federation/config-authority.js";
import {
  buildQqRuntimeOptionsContract,
  safeQqRuntimeOptionsJson,
} from "../qq/qq-runtime-options.js";
import { createNativeConfigArtifact, type NativeConfigArtifact } from "./native-config-types.js";

export function renderQqSdkNativeArtifact(config: EffectiveConfig): NativeConfigArtifact {
  const contract = buildQqRuntimeOptionsContract(config);
  const value = safeQqRuntimeOptionsJson(contract, {
    appId: config.secrets.qq_app_id.name,
    appSecret: config.secrets.qq_app_secret.name,
  });

  return createNativeConfigArtifact({
    component: "qq-sdk",
    relativePath: "qq/sdk-options.json",
    mediaType: "application/json",
    purpose: "Redacted QQ SDK constructor, session, and delivery runtime contract.",
    active: config.qq.mode === "real",
    runtimePlaceholders: [],
    content: `${JSON.stringify(value, null, 2)}\n`,
  });
}
