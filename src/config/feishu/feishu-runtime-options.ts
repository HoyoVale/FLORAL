import { createHash } from "node:crypto";
import type {
  EffectiveConfig,
  ResolvedConfigurationAuthority,
} from "../federation/config-authority.js";

export interface FeishuRuntimeOptionsContract {
  schemaVersion: 1;
  package: "@larksuiteoapi/node-sdk";
  expectedVersion: string;
  ingress: {
    mode: "long-connection";
    isolation: "worker-thread";
  };
  presentation: {
    visibleActivityFallback: boolean;
    visibleActivityDelayMs: number;
  };
  delivery: {
    startupTimeoutMs: number;
    outboundTimeoutMs: number;
    textChunkBytes: number;
    maxReplyChunks: number;
  };
  runtimeFingerprint: string;
}

export interface FeishuRuntimeCredentials {
  appId: string;
  appSecret: string;
}

export function buildFeishuRuntimeOptionsContract(
  config: EffectiveConfig,
): FeishuRuntimeOptionsContract {
  const withoutFingerprint = {
    schemaVersion: 1 as const,
    package: "@larksuiteoapi/node-sdk" as const,
    expectedVersion: config.feishu.sdk.expected_version,
    ingress: {
      mode: "long-connection" as const,
      isolation: config.feishu.sdk.ingress_isolation,
    },
    presentation: {
      visibleActivityFallback: config.feishu.presentation.visible_activity_fallback,
      visibleActivityDelayMs: config.feishu.presentation.visible_activity_delay_ms,
    },
    delivery: {
      startupTimeoutMs: config.feishu.startup_timeout_ms,
      outboundTimeoutMs: config.feishu.outbound_timeout_ms,
      textChunkBytes: config.feishu.text_chunk_bytes,
      maxReplyChunks: config.feishu.max_reply_chunks,
    },
  };
  validateFeishuRuntimeOptionsContract(withoutFingerprint);
  return {
    ...withoutFingerprint,
    runtimeFingerprint: fingerprint(withoutFingerprint),
  };
}

export function resolveFeishuRuntimeCredentials(
  authority: ResolvedConfigurationAuthority,
  environment: NodeJS.ProcessEnv,
): FeishuRuntimeCredentials {
  return {
    appId: readSecret(
      authority.effective.secrets.feishu_app_id.name,
      authority.effective.secrets.feishu_app_id.present,
      environment,
      "Feishu App ID",
    ),
    appSecret: readSecret(
      authority.effective.secrets.feishu_app_secret.name,
      authority.effective.secrets.feishu_app_secret.present,
      environment,
      "Feishu App secret",
    ),
  };
}

export function validateFeishuRuntimeOptionsContract(
  value: Omit<FeishuRuntimeOptionsContract, "runtimeFingerprint">
    | FeishuRuntimeOptionsContract,
): void {
  if (value.schemaVersion !== 1) {
    throw new Error("Unsupported Feishu runtime options schema");
  }
  if (value.package !== "@larksuiteoapi/node-sdk") {
    throw new Error("Unsupported Feishu SDK package");
  }
  if (!value.expectedVersion.trim()) {
    throw new Error("Feishu SDK version is required");
  }
  if (value.ingress.mode !== "long-connection") {
    throw new Error("Feishu ingress must use long connection");
  }
  if (value.ingress.isolation !== "worker-thread") {
    throw new Error("Feishu long connection must remain worker-thread isolated");
  }
  if (typeof value.presentation.visibleActivityFallback !== "boolean") {
    throw new Error("Feishu visible activity fallback flag must be boolean");
  }
  for (const [key, number] of Object.entries({
    visibleActivityDelayMs: value.presentation.visibleActivityDelayMs,
    ...value.delivery,
  })) {
    if (!Number.isInteger(number) || number <= 0) {
      throw new Error(`Feishu runtime option ${key} must be a positive integer`);
    }
  }
  if (
    "runtimeFingerprint" in value
    && value.runtimeFingerprint !== fingerprint({
      schemaVersion: value.schemaVersion,
      package: value.package,
      expectedVersion: value.expectedVersion,
      ingress: value.ingress,
      presentation: value.presentation,
      delivery: value.delivery,
    })
  ) {
    throw new Error("Feishu runtime options fingerprint mismatch");
  }
}

function readSecret(
  name: string,
  present: boolean,
  environment: NodeJS.ProcessEnv,
  label: string,
): string {
  const value = environment[name];
  if (!present || typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is missing from ${name}`);
  }
  return value.trim();
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
