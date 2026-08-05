import { z } from "zod";

const modeSchema = z.enum(["mock", "real"]);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  LOG_LEVEL: z.string().default("info"),
  DATA_DIR: z.string().default("./data"),
  QQ_MODE: modeSchema.default("mock"),
  CODEX_MODE: modeSchema.default("mock"),
  MACOS_MODE: modeSchema.default("mock"),
  AUTH_MODE: z.enum(["local", "better-auth"]).default("local"),
  QQBOT_APP_ID: z.string().optional(),
  QQBOT_APP_SECRET: z.string().optional(),
  CODEX_COMMAND: z.string().default("codex"),
  CODEX_ARGS: z.string().default("app-server"),
  CODEX_MODEL: z.string().default("deepseek-v4-flash"),
  CODEX_CWD: z.string().default("."),
  CODEX_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  BETTER_AUTH_SECRET: z.string().min(32).optional(),
  BETTER_AUTH_URL: z.string().url().default("http://127.0.0.1:8787"),
  OWNER_PAIRING_CODE: z.string().optional(),
  PEEKABOO_COMMAND: z.string().default("peekaboo")
});

export type AppEnv = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  if (parsed.data.QQ_MODE === "real") {
    if (!parsed.data.QQBOT_APP_ID || !parsed.data.QQBOT_APP_SECRET) {
      throw new Error("QQ_MODE=real requires QQBOT_APP_ID and QQBOT_APP_SECRET");
    }
  }

  return parsed.data;
}
