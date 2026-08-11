import { z } from "zod";

const modeSchema = z.enum(["mock", "real"]);
const chatTransportSchema = z.enum(["mock", "qq", "feishu"]);
const optionalNonEmptyString = z.preprocess(
  (value: unknown) => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().trim().min(1).optional(),
);
const booleanString = z.enum(["true", "false"])
  .transform((value: "true" | "false") => value === "true");
const optionalPairingCode = z.preprocess(
  (value: unknown) => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().trim().min(12).max(256).optional(),
);

const maintenanceModeValues = new Set(["manual", "owner-auto", "self-heal"]);

export interface EnvCompatibilityNotice {
  code: "maintenance-ceiling-misplaced";
  message: string;
}

export function normalizeEnvCompatibility(
  source: NodeJS.ProcessEnv = process.env,
): { source: NodeJS.ProcessEnv; notices: EnvCompatibilityNotice[] } {
  const normalized: NodeJS.ProcessEnv = { ...source };
  const notices: EnvCompatibilityNotice[] = [];
  const remote = normalized.FLORAL_REMOTE_MODE_CEILING?.trim();
  const maintenance = normalized.FLORAL_MAINTENANCE_MODE_CEILING?.trim();

  // Phase 8D.1 introduced a second machine-local ceiling with deliberately
  // different values. A trusted owner can easily place owner-auto/self-heal
  // in the older FLORAL_REMOTE_MODE_CEILING slot. Treat that exact category
  // mismatch as a recoverable compatibility typo instead of preventing the
  // LaunchAgent service CLI from starting at all. The remote ceiling falls
  // back to its safe default; when the maintenance ceiling was not set, carry
  // the intended value across to it. Unknown values still fail validation.
  if (remote && maintenanceModeValues.has(remote)) {
    normalized.FLORAL_REMOTE_MODE_CEILING = "auto";
    if (!maintenance) normalized.FLORAL_MAINTENANCE_MODE_CEILING = remote;
    notices.push({
      code: "maintenance-ceiling-misplaced",
      message: `FLORAL_REMOTE_MODE_CEILING=${remote} was interpreted as FLORAL_MAINTENANCE_MODE_CEILING=${maintenance || remote}; remote mode ceiling fell back to auto`,
    });
  }

  return { source: normalized, notices };
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  LOG_LEVEL: z.string().default("info"),
  DATA_DIR: z.string().default("./data"),
  DATABASE_PATH: z.string().trim().min(1).default("./data/floral.sqlite"),
  FLORAL_INSTANCE_LOCK_PATH: z.string().trim().min(1).default("./data/floral.lock"),
  FLORAL_SERVICE_STATE_PATH: z.string().trim().min(1).default("./data/service-state.json"),
  FLORAL_SERVICE_MODE: z.enum(["foreground", "launchagent"]).default("foreground"),
  // Machine-local ceiling for remote execution-mode elevation. This is
  // intentionally not sourced from config/floral.toml because an Agent
  // working inside the project must not be able to raise its own ceiling.
  FLORAL_REMOTE_MODE_CEILING: z.enum(["auto", "full"]).default("auto"),
  // Machine-local ceiling for governed maintenance autonomy. Project files and
  // the model cannot raise this value; enabling owner-auto/self-heal requires
  // an explicit owner-controlled environment change followed by service restart.
  FLORAL_MAINTENANCE_MODE_CEILING: z.enum(["manual", "owner-auto", "self-heal"]).default("manual"),
  FLORAL_MAINTENANCE_MAX_ACTIONS_PER_HOUR: z.coerce.number().int().min(1).max(12).default(2),
  FLORAL_MAINTENANCE_COOLDOWN_MS: z.coerce.number().int().min(10_000).max(24 * 60 * 60_000).default(300_000),
  FLORAL_MAINTENANCE_FAILURE_THRESHOLD: z.coerce.number().int().min(1).max(8).default(2),
  FLORAL_MAINTENANCE_SELF_HEAL_INTERVAL_MS: z.coerce.number().int().min(15_000).max(60 * 60_000).default(60_000),
  // Optional machine-local parent directory whose direct child directories are
  // remotely selectable Codex projects. Like the full-access ceiling, this is
  // intentionally outside config/floral.toml.
  FLORAL_WORKSPACE_ROOT: optionalNonEmptyString,
  MOCK_TRUST_OWNER: booleanString.default(true),
  CHAT_TRANSPORT: z.preprocess(
    (value: unknown) => typeof value === "string" && value.trim() === "" ? undefined : value,
    chatTransportSchema.optional(),
  ),
  QQ_MODE: modeSchema.default("mock"),
  CODEX_MODE: modeSchema.default("mock"),
  MACOS_MODE: modeSchema.default("mock"),
  AUTH_MODE: z.enum(["local", "better-auth"]).default("local"),
  QQBOT_APP_ID: optionalNonEmptyString,
  QQBOT_APP_SECRET: optionalNonEmptyString,
  QQBOT_SESSION_DIR: optionalNonEmptyString,
  QQBOT_STARTUP_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
  QQBOT_REPLY_TARGET_TTL_MS: z.coerce.number().int().min(10_000).max(10 * 60_000).default(4 * 60_000),
  QQBOT_REPLY_TARGET_CACHE_ENTRIES: z.coerce.number().int().min(1).max(4_096).default(256),
  QQBOT_TEXT_CHUNK_CHARACTERS: z.coerce.number().int().min(200).max(4_000).default(1_800),
  QQBOT_MAX_REPLY_CHUNKS: z.coerce.number().int().min(1).max(5).default(4),
  QQBOT_OUTBOUND_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
  QQBOT_PROBE_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(10 * 60_000).default(120_000),
  QQBOT_FULL_CHAIN_TIMEOUT_MS: z.coerce.number().int().min(30_000).max(20 * 60_000).default(300_000),
  QQBOT_RECONNECT_PROBE_TIMEOUT_MS: z.coerce.number().int().min(30_000).max(20 * 60_000).default(300_000),
  FEISHU_APP_ID: optionalNonEmptyString,
  FEISHU_APP_SECRET: optionalNonEmptyString,
  FEISHU_STARTUP_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
  FEISHU_OUTBOUND_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
  FEISHU_TEXT_CHUNK_BYTES: z.coerce.number().int().min(1_024).max(140_000).default(120_000),
  FEISHU_MAX_REPLY_CHUNKS: z.coerce.number().int().min(1).max(5).default(4),
  FEISHU_PROBE_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(10 * 60_000).default(120_000),
  FEISHU_VISIBLE_ACTIVITY_FALLBACK: booleanString.default(true),
  FEISHU_VISIBLE_ACTIVITY_DELAY_MS: z.coerce.number().int().min(1_000).max(120_000).default(6_000),
  FEISHU_STATUS_CARD_ENABLED: booleanString.default(true),
  FEISHU_STATUS_CARD_UPDATE_INTERVAL_MS: z.coerce.number().int().min(1_000).max(60_000).default(5_000),
  FEISHU_STATUS_CARD_AUTO_PIN: booleanString.default(true),
  CODEX_COMMAND: z.string().default("codex"),
  CODEX_ARGS: z.string().default("app-server"),
  CODEX_MODEL: optionalNonEmptyString,
  CODEX_CWD: z.string().default("."),
  CODEX_MANAGED_HOME: z.string().trim().min(1).default("./data/codex-runtime"),
  CODEX_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  // A separate, generous completion watchdog. 0 remains an explicit escape
  // hatch, but the default is finite so a protocol deadlock cannot wedge one
  // conversation forever.
  CODEX_TURN_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(7_200_000),
  DEEPSEEK_API_KEY: optionalNonEmptyString,
  MIMO_API_KEY: optionalNonEmptyString,
  // Optional machine-local credential used only by the curated read-only GitHub MCP.
  // The value stays in the parent process environment; generated Codex config
  // references only the variable name through bearer_token_env_var.
  GITHUB_PAT_TOKEN: optionalNonEmptyString,
  DEEPSEEK_BASE_URL: z.string().url().default("https://api.deepseek.com"),
  DEEPSEEK_MODEL: z.string().trim().min(1).default("deepseek-v4-flash"),
  DEEPSEEK_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  DEEPSEEK_THINKING: z.enum(["enabled", "disabled"]).default("enabled"),
  DEEPSEEK_REASONING_EFFORT: z.enum(["high", "max"]).default("high"),
  DEEPSEEK_PRESTREAM_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(4).default(2),
  DEEPSEEK_RETRY_BASE_DELAY_MS: z.coerce.number().int().min(0).max(30_000).default(250),
  DEEPSEEK_RETRY_MAX_DELAY_MS: z.coerce.number().int().min(0).max(60_000).default(2_000),
  FLORAL_BRIDGE_HOST: z.string().trim().min(1).default("127.0.0.1"),
  FLORAL_BRIDGE_PORT: z.coerce.number().int().min(0).max(65535).default(8790),
  FLORAL_BRIDGE_TOKEN: optionalNonEmptyString,
  FLORAL_BRIDGE_MAX_BODY_BYTES: z.coerce.number().int().min(1024).max(16 * 1024 * 1024).default(4 * 1024 * 1024),
  FLORAL_BRIDGE_MAX_CONCURRENT_REQUESTS: z.coerce.number().int().min(1).max(64).default(4),
  FLORAL_BRIDGE_MAX_QUEUED_REQUESTS: z.coerce.number().int().min(0).max(256).default(8),
  FLORAL_BRIDGE_QUEUE_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(15_000),
  SEARXNG_URL: z.string().url().default("http://127.0.0.1:8888"),
  SEARXNG_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  SEARXNG_MCP_PACKAGE: z.string().trim().min(1).default("mcp-searxng@1.0.3"),
  SEARXNG_MCP_STARTUP_TIMEOUT_SEC: z.coerce.number().int().positive().default(60),
  SEARXNG_MCP_TOOL_TIMEOUT_SEC: z.coerce.number().int().positive().default(45),
  BETTER_AUTH_SECRET: z.string().min(32).optional(),
  BETTER_AUTH_URL: z.string().url().default("http://127.0.0.1:8787"),
  OWNER_PAIRING_CODE: optionalPairingCode,
  PEEKABOO_COMMAND: z.string().default("peekaboo"),
});

export type AppEnv = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const normalized = normalizeEnvCompatibility(source);
  const parsed = envSchema.safeParse(normalized.source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue: { path: PropertyKey[]; message: string }) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  if (
    parsed.data.DEEPSEEK_RETRY_MAX_DELAY_MS
    < parsed.data.DEEPSEEK_RETRY_BASE_DELAY_MS
  ) {
    throw new Error(
      "DEEPSEEK_RETRY_MAX_DELAY_MS must be greater than or equal to DEEPSEEK_RETRY_BASE_DELAY_MS",
    );
  }

  if (parsed.data.CODEX_MODE === "real" && !parsed.data.DEEPSEEK_API_KEY) {
    throw new Error("CODEX_MODE=real requires DEEPSEEK_API_KEY");
  }

  const chatTransport = resolveChatTransport(parsed.data);
  if (chatTransport === "qq") {
    if (!parsed.data.QQBOT_APP_ID || !parsed.data.QQBOT_APP_SECRET) {
      throw new Error("QQ chat transport requires QQBOT_APP_ID and QQBOT_APP_SECRET");
    }
    if (!parsed.data.OWNER_PAIRING_CODE) {
      throw new Error("QQ chat transport requires OWNER_PAIRING_CODE with at least 12 characters");
    }
  }

  if (chatTransport === "feishu") {
    if (!parsed.data.FEISHU_APP_ID || !parsed.data.FEISHU_APP_SECRET) {
      throw new Error("Feishu chat transport requires FEISHU_APP_ID and FEISHU_APP_SECRET");
    }
    if (!parsed.data.OWNER_PAIRING_CODE) {
      throw new Error("Feishu chat transport requires OWNER_PAIRING_CODE with at least 12 characters");
    }
  }

  return parsed.data;
}

export type ChatTransportSelection = z.infer<typeof chatTransportSchema>;

/**
 * `CHAT_TRANSPORT` is the new explicit selector. When it is absent, keep the
 * established QQ_MODE behavior so existing deployments do not switch transports
 * during the Feishu migration.
 */
export function resolveChatTransport(env: AppEnv): ChatTransportSelection {
  return env.CHAT_TRANSPORT ?? (env.QQ_MODE === "real" ? "qq" : "mock");
}
