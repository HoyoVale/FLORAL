import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readCodexNativeMemoryPhase2Forensics,
  renderCodexNativeMemoryPhase2ForensicLines,
} from "../src/agent/codex-native-memory-forensics.js";
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

console.log("codex_memory_forensic_scope=local-terminal-only");
console.log("codex_memory_forensic_database_mode=read-only");
console.log("codex_memory_forensic_warning=excerpt-is-redacted-but-still-local-only");
const result = await readCodexNativeMemoryPhase2Forensics({ managedHome });
for (const line of renderCodexNativeMemoryPhase2ForensicLines(result)) console.log(line);
