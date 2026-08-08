import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readCodexNativeMemoryRuntimeStatus,
  renderCodexNativeMemoryRuntimeLines,
} from "../src/agent/codex-native-memory-status.js";
import { resolveConfigurationAuthority } from "../src/config/federation/config-authority.js";
import { loadProjectEnv } from "../src/config/load-project-env.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadProjectEnv(join(repositoryRoot, ".env"));
const authority = await resolveConfigurationAuthority({
  repositoryRoot,
  environment: process.env,
});
const codex = authority.effective.codex;
const status = await readCodexNativeMemoryRuntimeStatus({
  repositoryRoot,
  managedHome: codex.managed_home,
  config: codex.memories,
});

for (const line of renderCodexNativeMemoryRuntimeLines(status)) {
  console.log(line);
}

const mode = process.argv[2] ?? "show";
if (mode !== "show" && mode !== "check") {
  throw new Error(`Unknown native-memory lifecycle mode: ${mode}`);
}
if (mode === "check") {
  if (!status.effective) {
    console.error("codex_memory_lifecycle_check=inactive");
    process.exitCode = 2;
  } else if (status.lifecycle !== "consolidated") {
    console.error(`codex_memory_lifecycle_check=waiting:${status.lifecycle}`);
    process.exitCode = 3;
  } else {
    console.log("codex_memory_lifecycle_check=consolidated");
  }
}
