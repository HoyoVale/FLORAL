import type { EffectiveConfig } from "../federation/config-authority.js";
import { createNativeConfigArtifact, type NativeConfigArtifact } from "./native-config-types.js";

export function renderQqSdkNativeArtifact(config: EffectiveConfig): NativeConfigArtifact {
  const sdk = config.qq.sdk;
  const value = {
    schemaVersion: 1,
    package: "@tencent-connect/qqbot-nodejs",
    expectedVersion: sdk.expected_version,
    mode: config.qq.mode,
    constructor: {
      credentials: {
        appId: { kind: "environment", name: config.secrets.qq_app_id.name },
        appSecret: { kind: "environment", name: config.secrets.qq_app_secret.name },
      },
      accountIdStrategy: sdk.account_id_strategy,
      sessionPersistence: sdk.session_persistence,
      tokenPrefetch: sdk.token_prefetch,
      logger: sdk.logger,
    },
    delivery: {
      startupTimeoutMs: config.qq.startup_timeout_ms,
      replyTargetTtlMs: config.qq.reply_target_ttl_ms,
      replyTargetCacheEntries: config.qq.reply_target_cache_entries,
      textChunkCharacters: config.qq.text_chunk_characters,
      maxReplyChunks: config.qq.max_reply_chunks,
      outboundTimeoutMs: config.qq.outbound_timeout_ms,
    },
  };

  return createNativeConfigArtifact({
    component: "qq-sdk",
    relativePath: "qq/sdk-options.json",
    mediaType: "application/json",
    purpose: "Redacted QQ SDK constructor and FLORAL delivery policy contract.",
    active: config.qq.mode === "real",
    runtimePlaceholders: [],
    content: `${JSON.stringify(value, null, 2)}\n`,
  });
}
