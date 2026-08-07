import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { AppEnv } from "../env.js";
import type { EffectiveConfig, ResolvedConfigurationAuthority } from "../federation/config-authority.js";
import type { QqSdkRuntimePolicy, QqTransportOptions } from "../../transport/qq/qq-transport.js";

export interface QqRuntimeOptionsContract {
  schemaVersion: 1;
  package: "@tencent-connect/qqbot-nodejs";
  expectedVersion: string;
  mode: "mock" | "real";
  sdk: QqSdkRuntimePolicy;
  session: {
    root: string;
    layout: "qq/account-fingerprint/session.json";
  };
  presentation: {
    nativeTyping: boolean;
  };
  delivery: {
    startupTimeoutMs: number;
    replyTargetTtlMs: number;
    replyTargetCacheEntries: number;
    textChunkCharacters: number;
    maxReplyChunks: number;
    outboundTimeoutMs: number;
  };
  runtimeFingerprint: string;
}

export interface QqRuntimeCredentials {
  appId: string;
  appSecret: string;
}

export function buildQqRuntimeOptionsContract(
  config: EffectiveConfig,
): QqRuntimeOptionsContract {
  const withoutFingerprint = {
    schemaVersion: 1 as const,
    package: "@tencent-connect/qqbot-nodejs" as const,
    expectedVersion: config.qq.sdk.expected_version,
    mode: config.qq.mode,
    sdk: {
      accountIdStrategy: config.qq.sdk.account_id_strategy,
      sessionPersistence: config.qq.sdk.session_persistence,
      tokenPrefetch: config.qq.sdk.token_prefetch,
      logger: config.qq.sdk.logger,
    },
    session: {
      root: config.qq.session_dir,
      layout: "qq/account-fingerprint/session.json" as const,
    },
    presentation: {
      nativeTyping: config.qq.presentation.native_typing,
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
  validateQqRuntimeOptionsContract(withoutFingerprint);
  return {
    ...withoutFingerprint,
    runtimeFingerprint: fingerprint(withoutFingerprint),
  };
}

export function buildLegacyQqRuntimeOptionsContract(env: AppEnv): QqRuntimeOptionsContract {
  const withoutFingerprint = {
    schemaVersion: 1 as const,
    package: "@tencent-connect/qqbot-nodejs" as const,
    expectedVersion: "1.0.4",
    mode: env.QQ_MODE,
    sdk: {
      accountIdStrategy: "sha256-app-id" as const,
      sessionPersistence: "file" as const,
      tokenPrefetch: "sync" as const,
      logger: "redacted" as const,
    },
    session: {
      root: env.QQBOT_SESSION_DIR ?? `${env.DATA_DIR}/qq-session`,
      layout: "qq/account-fingerprint/session.json" as const,
    },
    presentation: {
      nativeTyping: false,
    },
    delivery: {
      startupTimeoutMs: env.QQBOT_STARTUP_TIMEOUT_MS,
      replyTargetTtlMs: env.QQBOT_REPLY_TARGET_TTL_MS,
      replyTargetCacheEntries: env.QQBOT_REPLY_TARGET_CACHE_ENTRIES,
      textChunkCharacters: env.QQBOT_TEXT_CHUNK_CHARACTERS,
      maxReplyChunks: env.QQBOT_MAX_REPLY_CHUNKS,
      outboundTimeoutMs: env.QQBOT_OUTBOUND_TIMEOUT_MS,
    },
  };
  validateQqRuntimeOptionsContract(withoutFingerprint);
  return {
    ...withoutFingerprint,
    runtimeFingerprint: fingerprint(withoutFingerprint),
  };
}

export function resolveQqRuntimeCredentials(
  authority: ResolvedConfigurationAuthority,
  environment: NodeJS.ProcessEnv,
): QqRuntimeCredentials {
  const appId = readSecret(
    authority.effective.secrets.qq_app_id.name,
    authority.effective.secrets.qq_app_id.present,
    environment,
  );
  const appSecret = readSecret(
    authority.effective.secrets.qq_app_secret.name,
    authority.effective.secrets.qq_app_secret.present,
    environment,
  );
  return { appId, appSecret };
}

export function createUnifiedQqTransportOptions(input: {
  authority: ResolvedConfigurationAuthority;
  repositoryRoot: string;
  environment: NodeJS.ProcessEnv;
  createBot?: QqTransportOptions["createBot"];
  now?: QqTransportOptions["now"];
}): QqTransportOptions {
  const contract = buildQqRuntimeOptionsContract(input.authority.effective);
  const credentials = resolveQqRuntimeCredentials(input.authority, input.environment);
  return createQqTransportOptionsFromContract({
    contract,
    credentials,
    repositoryRoot: input.repositoryRoot,
    ...(input.createBot ? { createBot: input.createBot } : {}),
    ...(input.now ? { now: input.now } : {}),
  });
}

export function createQqTransportOptionsFromContract(input: {
  contract: QqRuntimeOptionsContract;
  credentials: QqRuntimeCredentials;
  repositoryRoot: string;
  createBot?: QqTransportOptions["createBot"];
  now?: QqTransportOptions["now"];
}): QqTransportOptions {
  validateQqRuntimeOptionsContract(input.contract);
  const sessionRoot = isAbsolute(input.contract.session.root)
    ? resolve(input.contract.session.root)
    : resolve(input.repositoryRoot, input.contract.session.root);
  return {
    appId: requireSecret(input.credentials.appId, "QQ App ID"),
    appSecret: requireSecret(input.credentials.appSecret, "QQ App secret"),
    dataDir: sessionRoot,
    startupTimeoutMs: input.contract.delivery.startupTimeoutMs,
    replyTargetTtlMs: input.contract.delivery.replyTargetTtlMs,
    replyTargetCacheEntries: input.contract.delivery.replyTargetCacheEntries,
    textChunkCharacters: input.contract.delivery.textChunkCharacters,
    maxReplyChunks: input.contract.delivery.maxReplyChunks,
    outboundTimeoutMs: input.contract.delivery.outboundTimeoutMs,
    nativeTypingEnabled: input.contract.presentation.nativeTyping,
    sdk: input.contract.sdk,
    ...(input.createBot ? { createBot: input.createBot } : {}),
    ...(input.now ? { now: input.now } : {}),
  };
}

export function safeQqRuntimeOptionsJson(
  contract: QqRuntimeOptionsContract,
  secretNames: { appId: string; appSecret: string },
): Record<string, unknown> {
  validateQqRuntimeOptionsContract(contract);
  return {
    schemaVersion: contract.schemaVersion,
    package: contract.package,
    expectedVersion: contract.expectedVersion,
    mode: contract.mode,
    constructor: {
      credentials: {
        appId: { kind: "environment", name: secretNames.appId },
        appSecret: { kind: "environment", name: secretNames.appSecret },
      },
      accountIdStrategy: contract.sdk.accountIdStrategy,
      sessionPersistence: contract.sdk.sessionPersistence,
      tokenPrefetch: contract.sdk.tokenPrefetch,
      logger: contract.sdk.logger,
    },
    session: contract.session,
    presentation: contract.presentation,
    delivery: contract.delivery,
    runtimeFingerprint: contract.runtimeFingerprint,
  };
}

export function validateQqRuntimeOptionsContract(
  value: Omit<QqRuntimeOptionsContract, "runtimeFingerprint"> | QqRuntimeOptionsContract,
): void {
  if (value.schemaVersion !== 1) throw new Error("Unsupported QQ runtime options schema");
  if (value.package !== "@tencent-connect/qqbot-nodejs") {
    throw new Error("Unsupported QQ SDK package");
  }
  if (value.expectedVersion.trim() === "") throw new Error("QQ SDK version is required");
  if (!new Set(["mock", "real"]).has(value.mode)) throw new Error("Invalid QQ runtime mode");
  if (value.sdk.accountIdStrategy !== "sha256-app-id") {
    throw new Error("Unsupported QQ account ID strategy");
  }
  if (value.sdk.sessionPersistence !== "file") {
    throw new Error("Unsupported QQ session persistence mode");
  }
  if (!new Set(["sync", "async"]).has(value.sdk.tokenPrefetch)) {
    throw new Error("Unsupported QQ token prefetch mode");
  }
  if (value.sdk.logger !== "redacted") throw new Error("QQ SDK logger must remain redacted");
  if (value.session.root.trim() === "") throw new Error("QQ session root is required");
  if (value.session.layout !== "qq/account-fingerprint/session.json") {
    throw new Error("Unsupported QQ session layout");
  }
  if (typeof value.presentation.nativeTyping !== "boolean") {
    throw new Error("QQ native typing flag must be boolean");
  }
  for (const [key, number] of Object.entries(value.delivery)) {
    if (!Number.isInteger(number) || number <= 0) {
      throw new Error(`QQ delivery option ${key} must be a positive integer`);
    }
  }
  if (
    "runtimeFingerprint" in value
    && value.runtimeFingerprint !== fingerprint({
      schemaVersion: value.schemaVersion,
      package: value.package,
      expectedVersion: value.expectedVersion,
      mode: value.mode,
      sdk: value.sdk,
      session: value.session,
      presentation: value.presentation,
      delivery: value.delivery,
    })
  ) {
    throw new Error("QQ runtime options fingerprint mismatch");
  }
}

function readSecret(
  name: string,
  present: boolean,
  environment: NodeJS.ProcessEnv,
): string {
  const value = environment[name];
  if (!present || typeof value !== "string" || value.trim() === "") {
    throw new Error(`Required QQ credential is missing from ${name}`);
  }
  return value.trim();
}

function requireSecret(value: string, label: string): string {
  if (value.trim() === "") throw new Error(`${label} is required`);
  return value;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
