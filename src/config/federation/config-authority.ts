import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { AppEnv } from "../env.js";
import { loadEnv } from "../env.js";
import type { ConfigClassification } from "../inventory/config-inventory.js";
import type { RequestedConfig } from "./config-schema.js";
import {
  DEFAULT_REQUESTED_CONFIG,
  LOCKED_CONFIG_VALUES,
  requestedConfigSchema,
} from "./config-schema.js";
import { parseFloralToml } from "./simple-toml.js";

export type ConfigurationSource = "default" | "config-file" | "environment";

export interface ConfigurationProvenance {
  source: ConfigurationSource;
  sourceKey?: string | undefined;
  classification?: ConfigClassification | undefined;
  locked: boolean;
}

export type SecretId =
  | "deepseek_api_key"
  | "qq_app_id"
  | "qq_app_secret"
  | "bridge_token"
  | "better_auth_secret"
  | "owner_pairing_code";

export interface SecretRef {
  kind: "environment";
  name: string;
  present: boolean;
}

export interface EffectiveConfig extends RequestedConfig {
  secrets: Record<SecretId, SecretRef>;
}

export interface ResolvedConfigurationAuthority {
  authorityVersion: 1;
  configPath: string;
  requested: RequestedConfig;
  effective: EffectiveConfig;
  provenance: Record<string, ConfigurationProvenance>;
  environmentOverrideKeys: string[];
  requestedFingerprint: string;
  effectiveFingerprint: string;
  lockedPaths: string[];
}

export interface ResolveConfigurationAuthorityOptions {
  repositoryRoot: string;
  configPath?: string | undefined;
  environment?: NodeJS.ProcessEnv | undefined;
}

type EnvironmentKey = Extract<keyof AppEnv, string>;

interface EnvironmentBinding {
  key: EnvironmentKey;
  path: string;
  read: (env: AppEnv) => unknown;
}

export const SECRET_ENVIRONMENT_REFERENCES: Record<SecretId, string> = {
  deepseek_api_key: "DEEPSEEK_API_KEY",
  qq_app_id: "QQBOT_APP_ID",
  qq_app_secret: "QQBOT_APP_SECRET",
  bridge_token: "FLORAL_BRIDGE_TOKEN",
  better_auth_secret: "BETTER_AUTH_SECRET",
  owner_pairing_code: "OWNER_PAIRING_CODE",
};

export const ENVIRONMENT_BINDINGS: readonly EnvironmentBinding[] = [
  binding("NODE_ENV", "floral.node_env"),
  binding("HOST", "floral.host"),
  binding("PORT", "floral.port"),
  binding("LOG_LEVEL", "floral.log_level"),
  binding("DATA_DIR", "floral.data_dir"),
  binding("DATABASE_PATH", "floral.database_path"),
  binding("FLORAL_INSTANCE_LOCK_PATH", "floral.instance_lock_path"),
  binding("FLORAL_SERVICE_STATE_PATH", "floral.service_state_path"),
  binding("FLORAL_SERVICE_MODE", "floral.service_mode"),
  binding("MOCK_TRUST_OWNER", "floral.mock_trust_owner"),
  binding("QQ_MODE", "qq.mode"),
  binding("CODEX_MODE", "codex.mode"),
  binding("MACOS_MODE", "macos.mode"),
  binding("AUTH_MODE", "auth.mode"),
  binding("QQBOT_SESSION_DIR", "qq.session_dir"),
  binding("QQBOT_STARTUP_TIMEOUT_MS", "qq.startup_timeout_ms"),
  binding("QQBOT_REPLY_TARGET_TTL_MS", "qq.reply_target_ttl_ms"),
  binding("QQBOT_REPLY_TARGET_CACHE_ENTRIES", "qq.reply_target_cache_entries"),
  binding("QQBOT_TEXT_CHUNK_CHARACTERS", "qq.text_chunk_characters"),
  binding("QQBOT_MAX_REPLY_CHUNKS", "qq.max_reply_chunks"),
  binding("QQBOT_OUTBOUND_TIMEOUT_MS", "qq.outbound_timeout_ms"),
  binding("QQBOT_PROBE_TIMEOUT_MS", "qq.probe_timeout_ms"),
  binding("QQBOT_FULL_CHAIN_TIMEOUT_MS", "qq.full_chain_timeout_ms"),
  binding("QQBOT_RECONNECT_PROBE_TIMEOUT_MS", "qq.reconnect_probe_timeout_ms"),
  binding("CODEX_COMMAND", "codex.command"),
  {
    key: "CODEX_ARGS",
    path: "codex.args",
    read: (env) => splitCommandArguments(env.CODEX_ARGS),
  },
  binding("CODEX_MODEL", "codex.model"),
  binding("CODEX_CWD", "codex.cwd"),
  binding("CODEX_MANAGED_HOME", "codex.managed_home"),
  binding("CODEX_REQUEST_TIMEOUT_MS", "codex.request_timeout_ms"),
  binding("DEEPSEEK_BASE_URL", "deepseek.base_url"),
  binding("DEEPSEEK_MODEL", "deepseek.model"),
  binding("DEEPSEEK_REQUEST_TIMEOUT_MS", "deepseek.request_timeout_ms"),
  binding("DEEPSEEK_THINKING", "deepseek.thinking"),
  binding("DEEPSEEK_REASONING_EFFORT", "deepseek.reasoning_effort"),
  binding("DEEPSEEK_PRESTREAM_MAX_ATTEMPTS", "deepseek.prestream_max_attempts"),
  binding("DEEPSEEK_RETRY_BASE_DELAY_MS", "deepseek.retry_base_delay_ms"),
  binding("DEEPSEEK_RETRY_MAX_DELAY_MS", "deepseek.retry_max_delay_ms"),
  binding("FLORAL_BRIDGE_HOST", "bridge.host"),
  binding("FLORAL_BRIDGE_PORT", "bridge.port"),
  binding("FLORAL_BRIDGE_MAX_BODY_BYTES", "bridge.max_body_bytes"),
  binding("FLORAL_BRIDGE_MAX_CONCURRENT_REQUESTS", "bridge.max_concurrent_requests"),
  binding("FLORAL_BRIDGE_MAX_QUEUED_REQUESTS", "bridge.max_queued_requests"),
  binding("FLORAL_BRIDGE_QUEUE_TIMEOUT_MS", "bridge.queue_timeout_ms"),
  binding("SEARXNG_URL", "search.service_url"),
  binding("SEARXNG_REQUEST_TIMEOUT_MS", "search.request_timeout_ms"),
  binding("SEARXNG_MCP_PACKAGE", "mcp.search.package"),
  binding("SEARXNG_MCP_STARTUP_TIMEOUT_SEC", "mcp.search.startup_timeout_sec"),
  binding("SEARXNG_MCP_TOOL_TIMEOUT_SEC", "mcp.search.tool_timeout_sec"),
  binding("BETTER_AUTH_URL", "auth.better_auth_url"),
  binding("PEEKABOO_COMMAND", "macos.peekaboo_command"),
] as const;

export async function resolveConfigurationAuthority(
  options: ResolveConfigurationAuthorityOptions,
): Promise<ResolvedConfigurationAuthority> {
  const repositoryRoot = resolve(options.repositoryRoot);
  const configPath = resolveConfigPath(repositoryRoot, options.configPath);
  const [source, environmentPolicies] = await Promise.all([
    readFile(configPath, "utf8"),
    loadEnvironmentPolicies(repositoryRoot),
  ]);
  const parsedToml = parseFloralToml(source);
  const mergedRequested = deepMerge(
    structuredClone(DEFAULT_REQUESTED_CONFIG) as unknown as Record<string, unknown>,
    parsedToml.value,
  );
  const requested = parseRequestedConfig(mergedRequested, configPath);
  validateLockedValues(requested, "requested configuration");

  const rawEnvironment = options.environment ?? process.env;
  const parsedEnvironment = loadEnv(rawEnvironment);
  const effectiveBase = structuredClone(requested) as RequestedConfig;
  const provenance = buildRequestedProvenance(
    requested,
    parsedToml.explicitPaths,
    environmentPolicies,
  );
  const environmentOverrideKeys: string[] = [];

  for (const bindingEntry of ENVIRONMENT_BINDINGS) {
    if (!Object.hasOwn(rawEnvironment, bindingEntry.key)) continue;
    const value = bindingEntry.read(parsedEnvironment);
    if (value === undefined) continue;
    setAtPath(effectiveBase as unknown as Record<string, unknown>, bindingEntry.path, value);
    environmentOverrideKeys.push(bindingEntry.key);
    const classification = environmentPolicies[bindingEntry.key]?.classification;
    provenance[bindingEntry.path] = {
      source: "environment",
      sourceKey: bindingEntry.key,
      ...(classification ? { classification } : {}),
      locked: Object.hasOwn(LOCKED_CONFIG_VALUES, bindingEntry.path),
    };
  }

  const effectiveConfig = parseRequestedConfig(
    effectiveBase as unknown as Record<string, unknown>,
    "effective configuration",
  );
  validateLockedValues(effectiveConfig, "effective configuration");
  const secrets = buildSecretReferences(rawEnvironment);
  validateCrossFieldRules(effectiveConfig, secrets);

  const effective: EffectiveConfig = {
    ...effectiveConfig,
    secrets,
  };

  return {
    authorityVersion: 1,
    configPath,
    requested,
    effective,
    provenance,
    environmentOverrideKeys: environmentOverrideKeys.sort(),
    requestedFingerprint: fingerprint(requested),
    effectiveFingerprint: fingerprint(effective),
    lockedPaths: Object.keys(LOCKED_CONFIG_VALUES).sort(),
  };
}

export function renderConfigurationAuthority(
  authority: ResolvedConfigurationAuthority,
): string {
  const lines = [
    `config.authority_version=${String(authority.authorityVersion)}`,
    `config.path=${authority.configPath}`,
    `config.schema_version=${String(authority.effective.schema_version)}`,
    `config.profile=${authority.effective.profile}`,
    `config.requested_fingerprint=${authority.requestedFingerprint}`,
    `config.effective_fingerprint=${authority.effectiveFingerprint}`,
    `config.environment_overrides=${String(authority.environmentOverrideKeys.length)}`,
    `config.locked_paths=${String(authority.lockedPaths.length)}`,
    `config.codex.mode=${authority.effective.codex.mode}`,
    `config.codex.sandbox=${authority.effective.codex.sandbox.mode}`,
    `config.codex.approval=${authority.effective.codex.approval.policy}`,
    `config.codex.native.reasoning_effort=${authority.effective.codex.native.reasoning_effort}`,
    `config.codex.native.web_search=${authority.effective.codex.native.web_search}`,
    `config.runtime.adoption.codex=${authority.effective.runtime.adoption.codex.mode}`,
    `config.runtime.adoption.qq_sdk=${authority.effective.runtime.adoption.qq_sdk.mode}`,
    `config.runtime.adoption.searxng=${authority.effective.runtime.adoption.searxng.mode}`,
    `config.runtime.authorization.enabled=${String(authority.effective.runtime.authorization.enabled)}`,
    `config.runtime.authorization.approval_ttl_ms=${String(authority.effective.runtime.authorization.approval_ttl_ms)}`,
    `config.runtime.authorization.max_pending_approvals=${String(authority.effective.runtime.authorization.max_pending_approvals)}`,
    `config.runtime.authorization.owner_only_remote_approval=${String(authority.effective.runtime.authorization.owner_only_remote_approval)}`,
    `config.runtime.authorization.codex_turn_approval_policy=${authority.effective.runtime.authorization.codex_turn_approval_policy}`,
    `config.runtime.authorization.allow_remote_file_change_approval=${String(authority.effective.runtime.authorization.allow_remote_file_change_approval)}`,
    `config.runtime.authorization.local_confirmation_enabled=${String(authority.effective.runtime.authorization.local_confirmation_enabled)}`,
    `config.runtime.authorization.local_approval_ttl_ms=${String(authority.effective.runtime.authorization.local_approval_ttl_ms)}`,
    `config.runtime.authorization.local_approval_poll_ms=${String(authority.effective.runtime.authorization.local_approval_poll_ms)}`,
    `config.runtime.cost_guard.enabled=${String(authority.effective.runtime.cost_guard.enabled)}`,
    `config.runtime.cost_guard.max_requests_per_hour=${String(authority.effective.runtime.cost_guard.max_requests_per_hour)}`,
    `config.runtime.cost_guard.max_tokens_per_day=${String(authority.effective.runtime.cost_guard.max_tokens_per_day)}`,
    `config.runtime.cost_guard.max_cost_cny_per_day=${String(authority.effective.runtime.cost_guard.max_cost_cny_per_day)}`,
    `config.deepseek.model=${authority.effective.deepseek.model}`,
    `config.deepseek.reasoning_effort=${authority.effective.deepseek.reasoning_effort}`,
    `config.search.safe_search=${String(authority.effective.search.settings.safe_search)}`,
    `config.qq.sdk.expected_version=${authority.effective.qq.sdk.expected_version}`,
    `config.mcp.search.enabled=${String(authority.effective.mcp.search.enabled)}`,
    `config.mcp.vision.enabled=${String(authority.effective.mcp.vision.enabled)}`,
    `config.mcp.macos.enabled=${String(authority.effective.mcp.macos.enabled)}`,
  ];

  for (const id of Object.keys(authority.effective.secrets).sort() as SecretId[]) {
    lines.push(`config.secret.${id}=${authority.effective.secrets[id].present ? "present" : "missing"}`);
  }
  lines.push("config=ok");
  return `${lines.join("\n")}\n`;
}

export function safeConfigurationJson(
  authority: ResolvedConfigurationAuthority,
): Record<string, unknown> {
  return {
    authorityVersion: authority.authorityVersion,
    configPath: authority.configPath,
    requested: authority.requested,
    effective: authority.effective,
    provenance: authority.provenance,
    environmentOverrideKeys: authority.environmentOverrideKeys,
    requestedFingerprint: authority.requestedFingerprint,
    effectiveFingerprint: authority.effectiveFingerprint,
    lockedPaths: authority.lockedPaths,
  };
}

export function splitCommandArguments(value: string): string[] {
  const result: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (const character of value.trim()) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/u.test(character)) {
      if (current !== "") {
        result.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }
  if (escaped || quote) throw new Error("Invalid CODEX_ARGS quoting");
  if (current !== "") result.push(current);
  if (result.length === 0) throw new Error("CODEX_ARGS must contain at least one argument");
  return result;
}

export function listBoundEnvironmentKeys(): string[] {
  return [
    ...ENVIRONMENT_BINDINGS.map((entry) => entry.key),
    ...Object.values(SECRET_ENVIRONMENT_REFERENCES),
  ].sort();
}

function binding<Key extends EnvironmentKey>(key: Key, path: string): EnvironmentBinding {
  return {
    key,
    path,
    read: (env) => env[key],
  };
}

function parseRequestedConfig(
  value: Record<string, unknown>,
  sourceDescription: string,
): RequestedConfig {
  const parsed = requestedConfigSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const details = parsed.error.issues
    .map((issue: { path: PropertyKey[]; message: string }) => `${issue.path.join(".") || "configuration"}: ${issue.message}`)
    .join("\n");
  throw new Error(`Invalid ${sourceDescription}:\n${details}`);
}

function validateLockedValues(config: RequestedConfig, description: string): void {
  for (const [path, expected] of Object.entries(LOCKED_CONFIG_VALUES)) {
    const actual = getAtPath(config as unknown as Record<string, unknown>, path);
    if (!Object.is(actual, expected)) {
      throw new Error(
        `${description} attempts to override locked field ${path}; expected ${JSON.stringify(expected)}`,
      );
    }
  }
}

function validateCrossFieldRules(
  config: RequestedConfig,
  secrets: Record<SecretId, SecretRef>,
): void {
  if (config.deepseek.retry_max_delay_ms < config.deepseek.retry_base_delay_ms) {
    throw new Error("deepseek.retry_max_delay_ms must be greater than or equal to retry_base_delay_ms");
  }
  if (
    config.runtime.authorization.allow_remote_file_change_approval
    && config.runtime.authorization.codex_turn_approval_policy !== "on-request"
  ) {
    throw new Error("runtime.authorization.allow_remote_file_change_approval requires codex_turn_approval_policy=on-request");
  }
  if (
    config.runtime.authorization.codex_turn_approval_policy === "on-request"
    && !config.runtime.authorization.enabled
  ) {
    throw new Error("runtime.authorization.codex_turn_approval_policy=on-request requires authorization.enabled=true");
  }
  if (config.runtime.cost_guard.max_requests_per_hour < config.runtime.cost_guard.max_requests_per_minute) {
    throw new Error("runtime.cost_guard.max_requests_per_hour must be greater than or equal to max_requests_per_minute");
  }
  if (config.runtime.cost_guard.max_requests_per_day < config.runtime.cost_guard.max_requests_per_hour) {
    throw new Error("runtime.cost_guard.max_requests_per_day must be greater than or equal to max_requests_per_hour");
  }
  if (config.runtime.cost_guard.max_tokens_per_day < config.runtime.cost_guard.max_tokens_per_hour) {
    throw new Error("runtime.cost_guard.max_tokens_per_day must be greater than or equal to max_tokens_per_hour");
  }
  if (config.runtime.cost_guard.max_cost_cny_per_day < config.runtime.cost_guard.max_cost_cny_per_hour) {
    throw new Error("runtime.cost_guard.max_cost_cny_per_day must be greater than or equal to max_cost_cny_per_hour");
  }
  if (config.runtime.cost_guard.pricing.model !== config.deepseek.model) {
    throw new Error("runtime.cost_guard.pricing.model must match deepseek.model so estimated billing cannot silently use the wrong price table");
  }
  if (
    config.search.settings.outgoing_max_request_timeout_ms
    < config.search.settings.outgoing_request_timeout_ms
  ) {
    throw new Error(
      "search.settings.outgoing_max_request_timeout_ms must be greater than or equal to outgoing_request_timeout_ms",
    );
  }
  if (new Set(config.search.settings.formats).size !== config.search.settings.formats.length) {
    throw new Error("search.settings.formats contains duplicates");
  }
  if (!config.search.settings.formats.includes("json")) {
    throw new Error("search.settings.formats must include json for FLORAL MCP integration");
  }
  if (config.codex.mode === "real" && !secrets.deepseek_api_key.present) {
    throw new Error("codex.mode=real requires secret DEEPSEEK_API_KEY");
  }
  if (config.qq.mode === "real") {
    for (const id of ["qq_app_id", "qq_app_secret", "owner_pairing_code"] as const) {
      if (!secrets[id].present) throw new Error(`qq.mode=real requires secret ${secrets[id].name}`);
    }
  }
  if (config.auth.mode === "better-auth" && !secrets.better_auth_secret.present) {
    throw new Error("auth.mode=better-auth requires secret BETTER_AUTH_SECRET");
  }
  if (!isLoopbackHost(config.bridge.host)) {
    throw new Error("bridge.host must remain loopback-only");
  }
  const mcpIds = [config.mcp.search.id, config.mcp.vision.id, config.mcp.macos.id];
  if (new Set(mcpIds).size !== mcpIds.length) {
    throw new Error("mcp server IDs must be unique");
  }
  if (config.mcp.search.enabled && config.mcp.search.enabled_tools.length === 0) {
    throw new Error("mcp.search.enabled requires at least one enabled tool");
  }
  for (const [id, tools] of [
    ["search", config.mcp.search.enabled_tools],
    ["vision", config.mcp.vision.enabled_tools],
    ["macos", config.mcp.macos.enabled_tools],
  ] as const) {
    if (new Set(tools).size !== tools.length) {
      throw new Error(`mcp.${id}.enabled_tools contains duplicates`);
    }
  }
}

function buildSecretReferences(
  environment: NodeJS.ProcessEnv,
): Record<SecretId, SecretRef> {
  return Object.fromEntries(
    Object.entries(SECRET_ENVIRONMENT_REFERENCES).map(([id, name]) => [
      id,
      {
        kind: "environment" as const,
        name,
        present: typeof environment[name] === "string" && environment[name]?.trim() !== "",
      },
    ]),
  ) as Record<SecretId, SecretRef>;
}

function buildRequestedProvenance(
  requested: RequestedConfig,
  explicitPaths: Set<string>,
  policies: Record<string, { component: string; classification: ConfigClassification }>,
): Record<string, ConfigurationProvenance> {
  const envByPath = new Map(ENVIRONMENT_BINDINGS.map((entry) => [entry.path, entry.key]));
  return Object.fromEntries(
    flattenLeafPaths(requested).map((path) => {
      const environmentKey = envByPath.get(path);
      return [
        path,
        {
          source: explicitPaths.has(path) ? "config-file" as const : "default" as const,
          ...(environmentKey && policies[environmentKey]?.classification ? {
            classification: policies[environmentKey].classification,
          } : {}),
          locked: Object.hasOwn(LOCKED_CONFIG_VALUES, path),
        },
      ];
    }),
  );
}

async function loadEnvironmentPolicies(
  repositoryRoot: string,
): Promise<Record<string, { component: string; classification: ConfigClassification }>> {
  const source = await readFile(
    join(repositoryRoot, "config/catalog/upstream-config-catalog.json"),
    "utf8",
  );
  const parsed = JSON.parse(source) as {
    environmentKeyPolicies?: Record<string, { component: string; classification: ConfigClassification }>;
  };
  return parsed.environmentKeyPolicies ?? {};
}

function resolveConfigPath(repositoryRoot: string, configPath?: string): string {
  if (!configPath) return join(repositoryRoot, "config/floral.toml");
  return isAbsolute(configPath) ? configPath : resolve(repositoryRoot, configPath);
}

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  for (const [key, value] of Object.entries(source)) {
    if (isPlainRecord(value) && isPlainRecord(target[key])) {
      target[key] = deepMerge(target[key], value);
    } else {
      target[key] = structuredClone(value);
    }
  }
  return target;
}

function setAtPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split(".");
  const last = segments.pop();
  if (!last) throw new Error(`Invalid configuration path: ${path}`);
  let current = root;
  for (const segment of segments) {
    const next = current[segment];
    if (!isPlainRecord(next)) throw new Error(`Invalid configuration path: ${path}`);
    current = next;
  }
  current[last] = value;
}

function getAtPath(root: Record<string, unknown>, path: string): unknown {
  let current: unknown = root;
  for (const segment of path.split(".")) {
    if (!isPlainRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function flattenLeafPaths(value: unknown, prefix = ""): string[] {
  if (!isPlainRecord(value)) return prefix === "" ? [] : [prefix];
  const paths: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    if (isPlainRecord(child)) paths.push(...flattenLeafPaths(child, path));
    else paths.push(path);
  }
  return paths.sort();
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isPlainRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}
