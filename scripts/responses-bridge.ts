import { createResponsesBridge } from "../src/agent/bridge/bridge-factory.js";
import { loadEnv } from "../src/config/env.js";
import { loadProjectEnv } from "../src/config/load-project-env.js";

loadProjectEnv();
const env = loadEnv();

if (!env.FLORAL_BRIDGE_TOKEN) {
  throw new Error(
    "FLORAL_BRIDGE_TOKEN is required for bridge:start. Generate one with: openssl rand -hex 32",
  );
}

const bridge = createResponsesBridge(env, env.FLORAL_BRIDGE_TOKEN);
const address = await bridge.start();

console.log("bridge.service=floral-responses-bridge");
console.log(`bridge.listen=${address.baseUrl}`);
console.log("bridge.provider=deepseek");
console.log(`bridge.model=${env.DEEPSEEK_MODEL}`);
console.log("bridge.token=present");

const shutdown = async (signal: string) => {
  console.log(`bridge.shutdown=${signal}`);
  await bridge.stop();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
