import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { resolveLaunchAgentUserPaths } from "../src/service/launchagent-paths.js";

const PREFIX = "bridge.responses_telemetry=";
const MAX_BYTES = 1024 * 1024;
const MAX_LINES = 64;

const paths = resolveLaunchAgentUserPaths(homedir());
let text = "";
try {
  const buffer = await readFile(paths.stderr);
  text = buffer.length > MAX_BYTES
    ? buffer.subarray(buffer.length - MAX_BYTES).toString("utf8")
    : buffer.toString("utf8");
} catch {
  console.log("codex_memory_bridge_telemetry=log-unavailable");
  process.exit(0);
}

const lines = text
  .split(/\r?\n/u)
  .filter((line) => line.startsWith(PREFIX))
  .slice(-MAX_LINES);

console.log("codex_memory_bridge_telemetry=local-service-log");
console.log(`codex_memory_bridge_telemetry_log=${paths.stderr}`);
console.log(`codex_memory_bridge_telemetry_events=${lines.length}`);
console.log("codex_memory_bridge_telemetry_begin");
for (const line of lines) console.log(line);
console.log("codex_memory_bridge_telemetry_end");
