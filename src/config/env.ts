import { z } from "zod";

const modeSchema = z.enum(["mock", "real"]);
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

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  LOG_LEVEL: z.string().default("info"),
  DATA_DIR: z.string().default("./data"),
  DATABASE_PATH: z.string().trim().min(1).default("./data/floral.sqlite"),
  MOCK_TRUST_OWNER: booleanString.default(true),
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
  CODEX_COMMAND: z.string().default("codex"),
  CODEX_ARGS: z.string().default("app-server"),
  CODEX_MODEL: optionalNonEmptyString,
  CODEX_CWD: z.string().default("."),
  CODEX_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  DEEPSEEK_API_KEY: optionalNonEmptyString,
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
  const parsed = envSchema.safeParse(source);
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

  if (parsed.data.QQ_MODE === "real") {
    if (!parsed.data.QQBOT_APP_ID || !parsed.data.QQBOT_APP_SECRET) {
      throw new Error("QQ_MODE=real requires QQBOT_APP_ID and QQBOT_APP_SECRET");
    }
    if (!parsed.data.OWNER_PAIRING_CODE) {
      throw new Error("QQ_MODE=real requires OWNER_PAIRING_CODE with at least 12 characters");
    }
  }

  return parsed.data;
}
