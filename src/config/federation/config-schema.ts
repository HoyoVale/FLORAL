import { z } from "zod";

const modeSchema = z.enum(["mock", "real"]);
const positiveInteger = z.number().int().positive();
const nonNegativeInteger = z.number().int().nonnegative();
const boundedPort = z.number().int().min(0).max(65_535);
const strictStringArray = z.array(z.string().trim().min(1));

export const requestedConfigSchema = z.object({
  schema_version: z.literal(1),
  profile: z.string().trim().min(1),
  floral: z.object({
    node_env: z.enum(["development", "test", "production"]),
    host: z.string().trim().min(1),
    port: z.number().int().min(1).max(65_535),
    log_level: z.string().trim().min(1),
    data_dir: z.string().trim().min(1),
    database_path: z.string().trim().min(1),
    instance_lock_path: z.string().trim().min(1),
    service_state_path: z.string().trim().min(1),
    service_mode: z.enum(["foreground", "launchagent"]),
    mock_trust_owner: z.boolean(),
  }).strict(),
  qq: z.object({
    mode: modeSchema,
    session_dir: z.string().trim().min(1),
    startup_timeout_ms: positiveInteger,
    reply_target_ttl_ms: positiveInteger,
    reply_target_cache_entries: positiveInteger,
    text_chunk_characters: positiveInteger,
    max_reply_chunks: positiveInteger,
    outbound_timeout_ms: positiveInteger,
    probe_timeout_ms: positiveInteger,
    full_chain_timeout_ms: positiveInteger,
    reconnect_probe_timeout_ms: positiveInteger,
  }).strict(),
  codex: z.object({
    mode: modeSchema,
    command: z.string().trim().min(1),
    args: strictStringArray,
    model: z.string(),
    cwd: z.string().trim().min(1),
    managed_home: z.string().trim().min(1),
    request_timeout_ms: positiveInteger,
    native_web_search: z.boolean(),
    sandbox: z.object({
      mode: z.enum(["read-only", "workspace-write", "danger-full-access"]),
    }).strict(),
    approval: z.object({
      policy: z.enum(["never", "on-request", "on-failure", "untrusted"]),
    }).strict(),
  }).strict(),
  deepseek: z.object({
    base_url: z.string().url(),
    model: z.string().trim().min(1),
    request_timeout_ms: positiveInteger,
    thinking: z.enum(["enabled", "disabled"]),
    reasoning_effort: z.enum(["high", "max"]),
    prestream_max_attempts: z.number().int().min(1).max(4),
    retry_base_delay_ms: nonNegativeInteger,
    retry_max_delay_ms: nonNegativeInteger,
  }).strict(),
  bridge: z.object({
    host: z.string().trim().min(1),
    port: boundedPort,
    max_body_bytes: positiveInteger,
    max_concurrent_requests: positiveInteger,
    max_queued_requests: nonNegativeInteger,
    queue_timeout_ms: positiveInteger,
  }).strict(),
  search: z.object({
    service_url: z.string().url(),
    request_timeout_ms: positiveInteger,
  }).strict(),
  auth: z.object({
    mode: z.enum(["local", "better-auth"]),
    better_auth_url: z.string().url(),
    email_password_enabled: z.boolean(),
  }).strict(),
  macos: z.object({
    mode: modeSchema,
    peekaboo_command: z.string().trim().min(1),
  }).strict(),
  mcp: z.object({
    search: z.object({
      enabled: z.boolean(),
      id: z.string().trim().min(1),
      package: z.string().trim().min(1),
      enabled_tools: strictStringArray,
      required: z.boolean(),
      startup_timeout_sec: positiveInteger,
      tool_timeout_sec: positiveInteger,
      inherit_parent_environment: z.boolean(),
    }).strict(),
    vision: z.object({
      enabled: z.boolean(),
      id: z.string().trim().min(1),
      enabled_tools: strictStringArray,
      inherit_parent_environment: z.boolean(),
    }).strict(),
    macos: z.object({
      enabled: z.boolean(),
      id: z.string().trim().min(1),
      profile: z.enum(["observe", "control"]),
      enabled_tools: strictStringArray,
      inherit_parent_environment: z.boolean(),
    }).strict(),
  }).strict(),
}).strict();

export interface RequestedConfig {
  schema_version: 1;
  profile: string;
  floral: {
    node_env: "development" | "test" | "production";
    host: string;
    port: number;
    log_level: string;
    data_dir: string;
    database_path: string;
    instance_lock_path: string;
    service_state_path: string;
    service_mode: "foreground" | "launchagent";
    mock_trust_owner: boolean;
  };
  qq: {
    mode: "mock" | "real";
    session_dir: string;
    startup_timeout_ms: number;
    reply_target_ttl_ms: number;
    reply_target_cache_entries: number;
    text_chunk_characters: number;
    max_reply_chunks: number;
    outbound_timeout_ms: number;
    probe_timeout_ms: number;
    full_chain_timeout_ms: number;
    reconnect_probe_timeout_ms: number;
  };
  codex: {
    mode: "mock" | "real";
    command: string;
    args: string[];
    model: string;
    cwd: string;
    managed_home: string;
    request_timeout_ms: number;
    native_web_search: boolean;
    sandbox: { mode: "read-only" | "workspace-write" | "danger-full-access" };
    approval: { policy: "never" | "on-request" | "on-failure" | "untrusted" };
  };
  deepseek: {
    base_url: string;
    model: string;
    request_timeout_ms: number;
    thinking: "enabled" | "disabled";
    reasoning_effort: "high" | "max";
    prestream_max_attempts: number;
    retry_base_delay_ms: number;
    retry_max_delay_ms: number;
  };
  bridge: {
    host: string;
    port: number;
    max_body_bytes: number;
    max_concurrent_requests: number;
    max_queued_requests: number;
    queue_timeout_ms: number;
  };
  search: { service_url: string; request_timeout_ms: number };
  auth: {
    mode: "local" | "better-auth";
    better_auth_url: string;
    email_password_enabled: boolean;
  };
  macos: { mode: "mock" | "real"; peekaboo_command: string };
  mcp: {
    search: {
      enabled: boolean;
      id: string;
      package: string;
      enabled_tools: string[];
      required: boolean;
      startup_timeout_sec: number;
      tool_timeout_sec: number;
      inherit_parent_environment: boolean;
    };
    vision: {
      enabled: boolean;
      id: string;
      enabled_tools: string[];
      inherit_parent_environment: boolean;
    };
    macos: {
      enabled: boolean;
      id: string;
      profile: "observe" | "control";
      enabled_tools: string[];
      inherit_parent_environment: boolean;
    };
  };
}

export const DEFAULT_REQUESTED_CONFIG: RequestedConfig = {
  schema_version: 1,
  profile: "production",
  floral: {
    node_env: "development",
    host: "127.0.0.1",
    port: 8787,
    log_level: "info",
    data_dir: "./data",
    database_path: "./data/floral.sqlite",
    instance_lock_path: "./data/floral.lock",
    service_state_path: "./data/service-state.json",
    service_mode: "foreground",
    mock_trust_owner: true,
  },
  qq: {
    mode: "mock",
    session_dir: "./data/qq-session",
    startup_timeout_ms: 30_000,
    reply_target_ttl_ms: 240_000,
    reply_target_cache_entries: 256,
    text_chunk_characters: 1_800,
    max_reply_chunks: 4,
    outbound_timeout_ms: 30_000,
    probe_timeout_ms: 120_000,
    full_chain_timeout_ms: 300_000,
    reconnect_probe_timeout_ms: 300_000,
  },
  codex: {
    mode: "mock",
    command: "codex",
    args: ["app-server"],
    model: "",
    cwd: ".",
    managed_home: "./data/codex-runtime",
    request_timeout_ms: 120_000,
    native_web_search: false,
    sandbox: { mode: "read-only" },
    approval: { policy: "never" },
  },
  deepseek: {
    base_url: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
    request_timeout_ms: 120_000,
    thinking: "enabled",
    reasoning_effort: "high",
    prestream_max_attempts: 2,
    retry_base_delay_ms: 250,
    retry_max_delay_ms: 2_000,
  },
  bridge: {
    host: "127.0.0.1",
    port: 8790,
    max_body_bytes: 4 * 1024 * 1024,
    max_concurrent_requests: 4,
    max_queued_requests: 8,
    queue_timeout_ms: 15_000,
  },
  search: {
    service_url: "http://127.0.0.1:8888",
    request_timeout_ms: 15_000,
  },
  auth: {
    mode: "local",
    better_auth_url: "http://127.0.0.1:8787",
    email_password_enabled: false,
  },
  macos: {
    mode: "mock",
    peekaboo_command: "peekaboo",
  },
  mcp: {
    search: {
      enabled: true,
      id: "floral_search",
      package: "mcp-searxng@1.0.3",
      enabled_tools: ["searxng_web_search"],
      required: true,
      startup_timeout_sec: 60,
      tool_timeout_sec: 45,
      inherit_parent_environment: false,
    },
    vision: {
      enabled: false,
      id: "floral_vision",
      enabled_tools: ["vision_analyze_screen", "vision_analyze_region"],
      inherit_parent_environment: false,
    },
    macos: {
      enabled: false,
      id: "floral_peekaboo",
      profile: "observe",
      enabled_tools: ["image", "see"],
      inherit_parent_environment: false,
    },
  },
};

export const LOCKED_CONFIG_VALUES = {
  "codex.native_web_search": false,
  "codex.sandbox.mode": "read-only",
  "codex.approval.policy": "never",
  "auth.email_password_enabled": false,
  "mcp.search.inherit_parent_environment": false,
  "mcp.vision.inherit_parent_environment": false,
  "mcp.macos.inherit_parent_environment": false,
} as const;
