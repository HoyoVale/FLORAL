import { z } from "zod";

const modeSchema = z.enum(["mock", "real"]);
const positiveInteger = z.number().int().positive();
const nonNegativeInteger = z.number().int().nonnegative();
const positiveNumber = z.number().positive();
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
    chat_transport: z.enum(["auto", "mock", "qq", "feishu"]),
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
    presentation: z.object({
      native_typing: z.boolean(),
      visible_activity_fallback: z.boolean(),
      visible_activity_delay_ms: positiveInteger,
    }).strict(),
    sdk: z.object({
      expected_version: z.string().trim().min(1),
      account_id_strategy: z.literal("sha256-app-id"),
      session_persistence: z.literal("file"),
      token_prefetch: z.enum(["sync", "async"]),
      logger: z.literal("redacted"),
    }).strict(),
  }).strict(),
  feishu: z.object({
    startup_timeout_ms: positiveInteger,
    outbound_timeout_ms: positiveInteger,
    text_chunk_bytes: positiveInteger,
    max_reply_chunks: positiveInteger,
    probe_timeout_ms: positiveInteger,
    presentation: z.object({
      visible_activity_fallback: z.boolean(),
      visible_activity_delay_ms: positiveInteger,
    }).strict(),
    sdk: z.object({
      expected_version: z.string().trim().min(1),
      ingress_isolation: z.literal("worker-thread"),
      logger: z.literal("redacted"),
    }).strict(),
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
    native: z.object({
      provider_id: z.string().trim().min(1),
      wire_api: z.literal("responses"),
      reasoning_effort: z.enum(["inherit", "minimal", "low", "medium", "high", "xhigh"]),
      reasoning_summary: z.enum(["auto", "concise", "detailed", "none"]),
      web_search: z.enum(["disabled", "cached", "indexed", "live"]),
      request_max_retries: nonNegativeInteger,
      stream_max_retries: nonNegativeInteger,
      supports_websockets: z.boolean(),
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
    container: z.object({
      image: z.string().trim().min(1),
      container_name: z.string().trim().min(1),
      restart: z.enum(["no", "always", "on-failure", "unless-stopped"]),
      host_bind_address: z.string().trim().min(1),
      host_port: z.number().int().min(1).max(65_535),
      stop_grace_period_sec: positiveInteger,
      health_interval_sec: positiveInteger,
      health_timeout_sec: positiveInteger,
      health_retries: positiveInteger,
      health_start_period_sec: positiveInteger,
    }).strict(),
    settings: z.object({
      use_default_settings: z.boolean(),
      instance_name: z.string().trim().min(1),
      safe_search: z.number().int().min(0).max(2),
      autocomplete: z.string(),
      default_lang: z.string().trim().min(1),
      formats: strictStringArray,
      internal_port: z.number().int().min(1).max(65_535),
      bind_address: z.string().trim().min(1),
      limiter: z.boolean(),
      public_instance: z.boolean(),
      image_proxy: z.boolean(),
      method: z.enum(["GET", "POST"]),
      outgoing_request_timeout_ms: positiveInteger,
      outgoing_max_request_timeout_ms: positiveInteger,
      enable_http2: z.boolean(),
    }).strict(),
  }).strict(),
  auth: z.object({
    mode: z.enum(["local", "better-auth"]),
    better_auth_url: z.string().url(),
    email_password_enabled: z.boolean(),
  }).strict(),
  runtime: z.object({
    adoption: z.object({
      codex: z.object({
        mode: z.enum(["legacy", "unified-shadow", "unified"]),
      }).strict(),
      qq_sdk: z.object({
        mode: z.enum(["legacy", "unified"]),
      }).strict(),
      searxng: z.object({
        mode: z.enum(["legacy", "unified"]),
      }).strict(),
    }).strict(),
    authorization: z.object({
      enabled: z.boolean(),
      approval_ttl_ms: z.number().int().min(5_000).max(10 * 60_000),
      max_pending_approvals: z.number().int().min(1).max(32),
      owner_only_remote_approval: z.boolean(),
      codex_turn_approval_policy: z.enum(["never", "on-request", "untrusted"]),
      codex_turn_sandbox_mode: z.enum(["read-only", "workspace-write"]),
      codex_approvals_reviewer: z.literal("user"),
      allow_remote_file_change_approval: z.boolean(),
      local_confirmation_enabled: z.boolean(),
      local_approval_ttl_ms: z.number().int().min(5_000).max(30 * 60_000),
      local_approval_poll_ms: z.number().int().min(50).max(5_000),
    }).strict(),
    cost_guard: z.object({
      enabled: z.boolean(),
      state_path: z.string().trim().min(1),
      max_requests_per_minute: positiveInteger,
      max_requests_per_hour: positiveInteger,
      max_requests_per_day: positiveInteger,
      max_tokens_per_hour: positiveInteger,
      max_tokens_per_day: positiveInteger,
      max_cost_cny_per_hour: positiveNumber,
      max_cost_cny_per_day: positiveNumber,
      duplicate_window_ms: positiveInteger,
      duplicate_max_attempts: positiveInteger,
      max_unknown_usage_per_hour: positiveInteger,
      pricing: z.object({
        model: z.string().trim().min(1),
        input_cache_hit_cny_per_million: positiveNumber,
        input_cache_miss_cny_per_million: positiveNumber,
        output_cny_per_million: positiveNumber,
      }).strict(),
    }).strict(),
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
      command: z.string().trim().min(1),
      command_args: strictStringArray,
      no_proxy: z.string().trim().min(1),
      enabled_tools: strictStringArray,
      required: z.boolean(),
      startup_timeout_sec: positiveInteger,
      tool_timeout_sec: positiveInteger,
      default_tools_approval_mode: z.enum(["auto", "prompt", "writes", "approve"]),
      tool_approval_mode: z.enum(["auto", "prompt", "writes", "approve"]),
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
    chat_transport: "auto" | "mock" | "qq" | "feishu";
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
    presentation: {
      native_typing: boolean;
      visible_activity_fallback: boolean;
      visible_activity_delay_ms: number;
    };
    sdk: {
      expected_version: string;
      account_id_strategy: "sha256-app-id";
      session_persistence: "file";
      token_prefetch: "sync" | "async";
      logger: "redacted";
    };
  };
  feishu: {
    startup_timeout_ms: number;
    outbound_timeout_ms: number;
    text_chunk_bytes: number;
    max_reply_chunks: number;
    probe_timeout_ms: number;
    presentation: {
      visible_activity_fallback: boolean;
      visible_activity_delay_ms: number;
    };
    sdk: {
      expected_version: string;
      ingress_isolation: "worker-thread";
      logger: "redacted";
    };
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
    native: {
      provider_id: string;
      wire_api: "responses";
      reasoning_effort: "inherit" | "minimal" | "low" | "medium" | "high" | "xhigh";
      reasoning_summary: "auto" | "concise" | "detailed" | "none";
      web_search: "disabled" | "cached" | "indexed" | "live";
      request_max_retries: number;
      stream_max_retries: number;
      supports_websockets: boolean;
    };
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
  search: {
    service_url: string;
    request_timeout_ms: number;
    container: {
      image: string;
      container_name: string;
      restart: "no" | "always" | "on-failure" | "unless-stopped";
      host_bind_address: string;
      host_port: number;
      stop_grace_period_sec: number;
      health_interval_sec: number;
      health_timeout_sec: number;
      health_retries: number;
      health_start_period_sec: number;
    };
    settings: {
      use_default_settings: boolean;
      instance_name: string;
      safe_search: number;
      autocomplete: string;
      default_lang: string;
      formats: string[];
      internal_port: number;
      bind_address: string;
      limiter: boolean;
      public_instance: boolean;
      image_proxy: boolean;
      method: "GET" | "POST";
      outgoing_request_timeout_ms: number;
      outgoing_max_request_timeout_ms: number;
      enable_http2: boolean;
    };
  };
  auth: {
    mode: "local" | "better-auth";
    better_auth_url: string;
    email_password_enabled: boolean;
  };
  runtime: {
    adoption: {
      codex: {
        mode: "legacy" | "unified-shadow" | "unified";
      };
      qq_sdk: {
        mode: "legacy" | "unified";
      };
      searxng: {
        mode: "legacy" | "unified";
      };
    };
    authorization: {
      enabled: boolean;
      approval_ttl_ms: number;
      max_pending_approvals: number;
      owner_only_remote_approval: boolean;
      codex_turn_approval_policy: "never" | "on-request" | "untrusted";
      codex_turn_sandbox_mode: "read-only" | "workspace-write";
      codex_approvals_reviewer: "user";
      allow_remote_file_change_approval: boolean;
      local_confirmation_enabled: boolean;
      local_approval_ttl_ms: number;
      local_approval_poll_ms: number;
    };
    cost_guard: {
      enabled: boolean;
      state_path: string;
      max_requests_per_minute: number;
      max_requests_per_hour: number;
      max_requests_per_day: number;
      max_tokens_per_hour: number;
      max_tokens_per_day: number;
      max_cost_cny_per_hour: number;
      max_cost_cny_per_day: number;
      duplicate_window_ms: number;
      duplicate_max_attempts: number;
      max_unknown_usage_per_hour: number;
      pricing: {
        model: string;
        input_cache_hit_cny_per_million: number;
        input_cache_miss_cny_per_million: number;
        output_cny_per_million: number;
      };
    };
  };
  macos: { mode: "mock" | "real"; peekaboo_command: string };
  mcp: {
    search: {
      enabled: boolean;
      id: string;
      package: string;
      command: string;
      command_args: string[];
      no_proxy: string;
      enabled_tools: string[];
      required: boolean;
      startup_timeout_sec: number;
      tool_timeout_sec: number;
      default_tools_approval_mode: "auto" | "prompt" | "writes" | "approve";
      tool_approval_mode: "auto" | "prompt" | "writes" | "approve";
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
    chat_transport: "auto",
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
    presentation: {
      native_typing: false,
      visible_activity_fallback: true,
      visible_activity_delay_ms: 6_000,
    },
    sdk: {
      expected_version: "1.0.4",
      account_id_strategy: "sha256-app-id",
      session_persistence: "file",
      token_prefetch: "sync",
      logger: "redacted",
    },
  },
  feishu: {
    startup_timeout_ms: 30_000,
    outbound_timeout_ms: 30_000,
    text_chunk_bytes: 120_000,
    max_reply_chunks: 4,
    probe_timeout_ms: 120_000,
    presentation: {
      visible_activity_fallback: true,
      visible_activity_delay_ms: 6_000,
    },
    sdk: {
      expected_version: "1.36.0",
      ingress_isolation: "worker-thread",
      logger: "redacted",
    },
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
    native: {
      provider_id: "floral-deepseek",
      wire_api: "responses",
      reasoning_effort: "inherit",
      reasoning_summary: "auto",
      web_search: "disabled",
      request_max_retries: 0,
      stream_max_retries: 0,
      supports_websockets: false,
    },
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
    container: {
      image: "docker.io/searxng/searxng@sha256:02aa607ecc87165ebe6212476a176b8984d891c01a2d130ad03a58109d13db77",
      container_name: "floral-searxng",
      restart: "unless-stopped",
      host_bind_address: "127.0.0.1",
      host_port: 8_888,
      stop_grace_period_sec: 20,
      health_interval_sec: 30,
      health_timeout_sec: 7,
      health_retries: 3,
      health_start_period_sec: 20,
    },
    settings: {
      use_default_settings: true,
      instance_name: "FLORAL Search",
      safe_search: 1,
      autocomplete: "",
      default_lang: "auto",
      formats: ["html", "json"],
      internal_port: 8_080,
      bind_address: "0.0.0.0",
      limiter: false,
      public_instance: false,
      image_proxy: false,
      method: "GET",
      outgoing_request_timeout_ms: 5_000,
      outgoing_max_request_timeout_ms: 10_000,
      enable_http2: true,
    },
  },
  auth: {
    mode: "local",
    better_auth_url: "http://127.0.0.1:8787",
    email_password_enabled: false,
  },
  runtime: {
    adoption: {
      codex: {
        mode: "unified",
      },
      qq_sdk: {
        mode: "unified",
      },
      searxng: {
        mode: "unified",
      },
    },
    authorization: {
      enabled: true,
      approval_ttl_ms: 60_000,
      max_pending_approvals: 8,
      owner_only_remote_approval: true,
      codex_turn_approval_policy: "untrusted",
      codex_turn_sandbox_mode: "workspace-write",
      codex_approvals_reviewer: "user",
      allow_remote_file_change_approval: true,
      local_confirmation_enabled: true,
      local_approval_ttl_ms: 300_000,
      local_approval_poll_ms: 250,
    },
    cost_guard: {
      enabled: true,
      state_path: "./data/cost-guard/deepseek.json",
      max_requests_per_minute: 20,
      max_requests_per_hour: 120,
      max_requests_per_day: 1_000,
      max_tokens_per_hour: 5_000_000,
      max_tokens_per_day: 20_000_000,
      max_cost_cny_per_hour: 2,
      max_cost_cny_per_day: 10,
      duplicate_window_ms: 300_000,
      duplicate_max_attempts: 4,
      max_unknown_usage_per_hour: 8,
      pricing: {
        model: "deepseek-v4-flash",
        input_cache_hit_cny_per_million: 0.02,
        input_cache_miss_cny_per_million: 1,
        output_cny_per_million: 2,
      },
    },
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
      command: "npx",
      command_args: ["-y"],
      no_proxy: "127.0.0.1,localhost,::1",
      enabled_tools: ["searxng_web_search"],
      required: true,
      startup_timeout_sec: 60,
      tool_timeout_sec: 45,
      default_tools_approval_mode: "approve",
      tool_approval_mode: "approve",
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
  "runtime.authorization.enabled": true,
  "runtime.authorization.owner_only_remote_approval": true,
  "runtime.authorization.local_confirmation_enabled": true,
  "runtime.authorization.codex_turn_approval_policy": "untrusted",
  "runtime.authorization.codex_turn_sandbox_mode": "workspace-write",
  "runtime.authorization.codex_approvals_reviewer": "user",
  "codex.native_web_search": false,
  "codex.sandbox.mode": "read-only",
  "codex.native.provider_id": "floral-deepseek",
  "codex.native.wire_api": "responses",
  "codex.native.web_search": "disabled",
  "codex.approval.policy": "never",
  "auth.email_password_enabled": false,
  "qq.sdk.expected_version": "1.0.4",
  "qq.sdk.logger": "redacted",
  "feishu.sdk.expected_version": "1.36.0",
  "feishu.sdk.ingress_isolation": "worker-thread",
  "feishu.sdk.logger": "redacted",
  "search.container.host_bind_address": "127.0.0.1",
  "search.container.image": "docker.io/searxng/searxng@sha256:02aa607ecc87165ebe6212476a176b8984d891c01a2d130ad03a58109d13db77",
  "mcp.search.default_tools_approval_mode": "approve",
  "mcp.search.tool_approval_mode": "approve",
  "mcp.search.inherit_parent_environment": false,
  "mcp.vision.inherit_parent_environment": false,
  "mcp.macos.inherit_parent_environment": false,
} as const;
