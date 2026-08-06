import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assessQqRuntimeAdoptionReport,
  readQqRuntimeAdoptionReport,
  renderQqRuntimeAdoptionReport,
} from "../src/config/adoption/qq-runtime-options-adoption.js";
import { resolveConfigurationAuthority } from "../src/config/federation/config-authority.js";
import { loadProjectEnv } from "../src/config/load-project-env.js";
import { buildQqRuntimeOptionsContract } from "../src/config/qq/qq-runtime-options.js";
import { resolveInstalledQqSdkVersion } from "../src/transport/qq/qq-sdk-contract.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadProjectEnv(join(repositoryRoot, ".env"));
const command = process.argv[2] ?? "show";
if (!new Set(["show", "json", "check"]).has(command)) {
  throw new Error(`Unsupported QQ runtime adoption command: ${command}`);
}

const authority = await resolveConfigurationAuthority({
  repositoryRoot,
  environment: process.env,
});
const required = authority.effective.qq.mode === "real"
  && authority.effective.runtime.adoption.qq_sdk.mode === "unified";
const contract = buildQqRuntimeOptionsContract(authority.effective);
let report: Awaited<ReturnType<typeof readQqRuntimeAdoptionReport>>;
let invalid = false;
try {
  report = await readQqRuntimeAdoptionReport(repositoryRoot);
} catch {
  invalid = true;
}
let installedSdkVersion = "unavailable";
try {
  installedSdkVersion = await resolveInstalledQqSdkVersion();
} catch {
  // Diagnostics will report the package observation separately.
}
const currentStatus = !required
  ? "disabled"
  : invalid
    ? "invalid"
    : !report
      ? "missing"
      : assessQqRuntimeAdoptionReport(report, contract, installedSdkVersion);

if (command === "json") {
  process.stdout.write(`${JSON.stringify({
    required,
    currentStatus,
    runtimeFingerprint: contract.runtimeFingerprint,
    installedSdkVersion,
    report: report ?? null,
  }, null, 2)}\n`);
} else if (report) {
  process.stdout.write(renderQqRuntimeAdoptionReport(report));
  process.stdout.write(`config.qq_adoption.current_runtime_fingerprint=${contract.runtimeFingerprint}\n`);
  process.stdout.write(`config.qq_adoption.current_sdk_version=${installedSdkVersion}\n`);
  process.stdout.write(`config.qq_adoption.current_status=${currentStatus}\n`);
} else {
  process.stdout.write(`config.qq_adoption.required=${String(required)}\n`);
  process.stdout.write(`config.qq_adoption.current_runtime_fingerprint=${contract.runtimeFingerprint}\n`);
  process.stdout.write(`config.qq_adoption.current_sdk_version=${installedSdkVersion}\n`);
  process.stdout.write(`config.qq_adoption.current_status=${currentStatus}\n`);
}

if (command === "check" && required && currentStatus !== "active") {
  process.exitCode = 2;
}
