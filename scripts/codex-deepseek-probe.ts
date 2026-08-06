import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServerRuntime } from "../src/agent/codex-app-server.js";
import { CodexRuntimeError } from "../src/agent/codex-errors.js";
import { createResponsesBridge } from "../src/agent/bridge/bridge-factory.js";
import { loadEnv } from "../src/config/env.js";
import { loadProjectEnv } from "../src/config/load-project-env.js";

loadProjectEnv();
const env = loadEnv();
const token = randomBytes(32).toString("hex");
const bridge = createResponsesBridge(env, token, 0);
const address = await bridge.start();
const codexHome = await mkdtemp(join(tmpdir(), "floral-codex-deepseek-"));

console.log("probe.chain=codex-app-server->floral-bridge->deepseek");
console.log(`probe.bridge_url=${address.baseUrl}`);
console.log(`probe.model=${env.DEEPSEEK_MODEL}`);

const config = [
  `model = ${tomlString(env.DEEPSEEK_MODEL)}`,
  `model_provider = "floral-deepseek"`,
  `model_reasoning_effort = "high"`,
  ``,
  `[model_providers.floral-deepseek]`,
  `name = "FLORAL DeepSeek Bridge"`,
  `base_url = ${tomlString(address.baseUrl)}`,
  `wire_api = "responses"`,
  `env_key = "FLORAL_BRIDGE_TOKEN"`,
  `request_max_retries = 0`,
  `stream_max_retries = 0`,
  `stream_idle_timeout_ms = ${env.DEEPSEEK_REQUEST_TIMEOUT_MS}`,
  `supports_websockets = false`,
  ``,
].join("\n");
await writeFile(join(codexHome, "config.toml"), config, { encoding: "utf8", mode: 0o600 });

const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
  CODEX_HOME: codexHome,
  FLORAL_BRIDGE_TOKEN: token,
};
delete childEnv.DEEPSEEK_API_KEY;

const runtime = new CodexAppServerRuntime({
  command: env.CODEX_COMMAND,
  args: env.CODEX_ARGS.split(/\s+/).filter(Boolean),
  requestTimeoutMs: env.CODEX_REQUEST_TIMEOUT_MS,
  defaultModel: env.DEEPSEEK_MODEL,
  processCwd: env.CODEX_CWD,
  processEnv: childEnv,
});

try {
  await runtime.start();
  console.log("probe.initialize=ok");
  const result = await runtime.run(
    {
      text: "Reply with exactly: FLORAL_CODEX_DEEPSEEK_OK",
      cwd: env.CODEX_CWD,
      model: env.DEEPSEEK_MODEL,
    },
    (event) => {
      if (event.type === "run.started") console.log(`probe.thread=${event.threadId}`);
    },
  );
  console.log(`probe.final=${JSON.stringify(result.finalText.trim())}`);

  if (result.finalText.trim() === "FLORAL_CODEX_DEEPSEEK_OK") {
    console.log("probe.result=ok");
  } else {
    console.log("probe.result=unexpected-output");
    process.exitCode = 1;
  }
} catch (error) {
  const failure = error instanceof CodexRuntimeError
    ? error
    : new CodexRuntimeError({
        kind: "unknown",
        message: error instanceof Error ? error.message : String(error),
        cause: error,
      });
  console.log(`probe.error.kind=${failure.kind}`);
  console.log(`probe.error.retryable=${failure.retryable}`);
  console.log(`probe.error.message=${failure.message}`);
  console.log("probe.result=failed");
  process.exitCode = 1;
} finally {
  await runtime.stop();
  await bridge.stop();
  await rm(codexHome, { recursive: true, force: true });
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
