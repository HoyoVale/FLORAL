import { spawn } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseCodexMemoriesFeatureList,
  readCodexNativeMemoryRuntimeStatus,
  renderCodexNativeMemoryRuntimeLines,
  resolveCodexExecutableForProbe,
  type CodexMemoriesFeatureProbeResult,
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

const codexHome = isAbsolute(codex.managed_home)
  ? resolve(codex.managed_home)
  : resolve(repositoryRoot, codex.managed_home);
const resolvedCommand = await resolveCodexExecutableForProbe({
  command: codex.command,
  pathValue: process.env.PATH,
});
const feature: CodexMemoriesFeatureProbeResult & { error?: string | undefined } = resolvedCommand
  ? await probeMemoriesFeature(resolvedCommand, codexHome)
  : { status: "unavailable", error: "command-not-found" };
console.log(`codex_memory_feature_probe=${feature.status}`);
if (feature.stage) console.log(`codex_memory_feature_stage=${feature.stage}`);
if (feature.status === "unavailable") {
  console.log(`codex_memory_feature_error=${feature.error ?? "unknown"}`);
}

if (codex.memories.enabled && feature.status === "disabled") {
  process.exitCode = 2;
}
if (codex.memories.enabled && !status.effective) {
  process.exitCode = 2;
}

async function probeMemoriesFeature(
  command: string,
  codexHome: string,
): Promise<CodexMemoriesFeatureProbeResult & { error?: string | undefined }> {
  const environment = buildProbeEnvironment(process.env, codexHome);
  return await new Promise((resolveResult) => {
    const child = spawn(command, ["features", "list"], {
      cwd: repositoryRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const finish = (value: CodexMemoriesFeatureProbeResult & { error?: string | undefined }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ status: "unavailable", error: "timeout" });
    }, 15_000);
    child.once("error", () => finish({ status: "unavailable", error: "spawn-failed" }));
    child.once("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish({ status: "unavailable", error: `exit-${String(code ?? "signal")}` });
        return;
      }
      finish(parseCodexMemoriesFeatureList(`${stdout}\n${stderr}`));
    });
  });
}

function buildProbeEnvironment(
  source: NodeJS.ProcessEnv,
  codexHome: string,
): NodeJS.ProcessEnv {
  const allowed = [
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP",
    "LANG", "LC_ALL", "NO_PROXY", "HTTP_PROXY", "HTTPS_PROXY",
  ] as const;
  const environment: NodeJS.ProcessEnv = { CODEX_HOME: codexHome };
  for (const name of allowed) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  // `features list` does not contact the provider, but config parsing still sees
  // the provider env-key declaration. A non-secret placeholder avoids exporting
  // application/API secrets to the probe child.
  environment.FLORAL_BRIDGE_TOKEN = "floral-native-memory-probe-placeholder";
  return environment;
}
