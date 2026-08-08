import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assessCodexCapabilityBaseline,
  collectCodexCapabilityBaseline,
  readCodexCapabilityBaseline,
  renderCodexCapabilityBaseline,
  writeCodexCapabilityBaseline,
} from "../src/agent/codex-capability-baseline.js";
import { resolveConfigurationAuthority } from "../src/config/federation/config-authority.js";
import { loadProjectEnv } from "../src/config/load-project-env.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadProjectEnv(join(repositoryRoot, ".env"));

const mode = process.argv[2] ?? "show";
if (!new Set(["show", "json", "write", "check"]).has(mode)) {
  throw new Error(`Unknown Codex capability baseline mode: ${mode}`);
}

const authority = await resolveConfigurationAuthority({
  repositoryRoot,
  environment: process.env,
});
const codex = authority.effective.codex;
const processEnv = buildProbeEnvironment(
  process.env,
  resolve(repositoryRoot, codex.managed_home),
);

const current = await collectCodexCapabilityBaseline({
  command: codex.command,
  appServerArgs: codex.args,
  requestTimeoutMs: codex.request_timeout_ms,
  processCwd: resolve(repositoryRoot, codex.cwd),
  processEnv,
});

if (mode === "json") {
  process.stdout.write(`${JSON.stringify(current, null, 2)}\n`);
} else if (mode === "write") {
  const path = await writeCodexCapabilityBaseline(repositoryRoot, current);
  process.stdout.write(renderCodexCapabilityBaseline(current));
  console.log(`codex.capabilities.baseline_path=${path}`);
  console.log("codex.capabilities.baseline_status=written");
} else if (mode === "check") {
  const approved = await readCodexCapabilityBaseline(repositoryRoot);
  process.stdout.write(renderCodexCapabilityBaseline(current));
  if (!approved) {
    console.log("codex.capabilities.baseline_status=missing");
    console.log("codex.capabilities.instructions=run-codex:capabilities:write-after-review");
    process.exitCode = 2;
  } else {
    const status = assessCodexCapabilityBaseline(approved, current);
    console.log(`codex.capabilities.baseline_status=${status}`);
    console.log(`codex.capabilities.approved_fingerprint=${approved.compatibilityFingerprint}`);
    if (status !== "compatible") process.exitCode = 2;
  }
} else {
  process.stdout.write(renderCodexCapabilityBaseline(current));
}

function buildProbeEnvironment(
  source: NodeJS.ProcessEnv,
  codexHome: string,
): NodeJS.ProcessEnv {
  const allowedNames = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "NO_PROXY",
    "HTTP_PROXY",
    "HTTPS_PROXY",
  ] as const;
  const environment: NodeJS.ProcessEnv = {};
  for (const name of allowedNames) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  environment.CODEX_HOME = codexHome;
  // The managed config names FLORAL_BRIDGE_TOKEN as the model-provider env key.
  // This probe never starts a turn or provider request, so use a non-secret
  // placeholder and do not pass application/API secrets to the child process.
  environment.FLORAL_BRIDGE_TOKEN = "floral-capability-probe-placeholder";
  return environment;
}
