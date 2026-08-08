import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readCodexNativeMemoryPhase2Diagnostics,
  renderCodexNativeMemoryPhase2DiagnosticLines,
} from "../src/agent/codex-native-memory-diagnostics.js";
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
const managedHome = isAbsolute(codex.managed_home)
  ? resolve(codex.managed_home)
  : resolve(repositoryRoot, codex.managed_home);
const runtime = await readCodexNativeMemoryRuntimeStatus({
  repositoryRoot,
  managedHome,
  config: codex.memories,
});
const diagnostics = await readCodexNativeMemoryPhase2Diagnostics({
  managedHome,
  runtime,
});

for (const line of renderCodexNativeMemoryRuntimeLines(runtime)) console.log(line);
for (const line of renderCodexNativeMemoryPhase2DiagnosticLines(diagnostics)) console.log(line);
