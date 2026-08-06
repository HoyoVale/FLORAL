import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderNativeConfigBundle } from "../src/config/adapters/native-config-bundle.js";
import {
  buildConfigurationDiagnostics,
  cutoverIsReady,
  diagnosticsHasStructuralErrors,
  explainConfigurationPath,
  renderConfigurationDiagnostics,
  renderConfigurationExplanation,
  safeConfigurationDiagnosticsJson,
} from "../src/config/diagnostics/config-diagnostics.js";
import { resolveConfigurationAuthority } from "../src/config/federation/config-authority.js";
import { writeConfigurationDiagnostics } from "../src/config/federation/diagnostics-writer.js";
import { loadProjectEnv } from "../src/config/load-project-env.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadProjectEnv(join(repositoryRoot, ".env"));

const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "explain" && rawArgs[1] === "--"
  ? [rawArgs[0], ...rawArgs.slice(2)]
  : rawArgs;
const mode = args[0] ?? "show";
const supportedModes = new Set(["show", "json", "write", "check", "cutover", "explain"]);
if (!supportedModes.has(mode)) throw new Error(`Unknown config diagnostics mode: ${mode}`);

const configFlagIndex = args.indexOf("--config");
const configPath = configFlagIndex >= 0 ? args[configFlagIndex + 1] : undefined;
if (configFlagIndex >= 0 && !configPath) throw new Error("--config requires a path");
const noRuntime = args.includes("--no-runtime");
const explainPath = mode === "explain" ? args[1] : undefined;
if (mode === "explain" && (!explainPath || explainPath.startsWith("--"))) {
  throw new Error("config explain requires a dotted configuration path");
}
const consumed = new Set<number>([0]);
if (mode === "explain") consumed.add(1);
if (configFlagIndex >= 0) {
  consumed.add(configFlagIndex);
  consumed.add(configFlagIndex + 1);
}
const noRuntimeIndex = args.indexOf("--no-runtime");
if (noRuntimeIndex >= 0) consumed.add(noRuntimeIndex);
const unknownArguments = args.filter((_argument, index) => !consumed.has(index));
if (unknownArguments.length > 0) {
  throw new Error(`Unknown config diagnostics arguments: ${unknownArguments.join(", ")}`);
}

const authority = await resolveConfigurationAuthority({
  repositoryRoot,
  ...(configPath ? { configPath } : {}),
  environment: process.env,
});
const bundle = renderNativeConfigBundle(authority);

if (mode === "explain") {
  process.stdout.write(renderConfigurationExplanation(
    explainConfigurationPath(authority, bundle, explainPath as string),
  ));
} else {
  const report = await buildConfigurationDiagnostics({
    repositoryRoot,
    authority,
    includeRuntimeProbes: !noRuntime,
  });
  if (mode === "json") {
    process.stdout.write(`${JSON.stringify(safeConfigurationDiagnosticsJson(report), null, 2)}\n`);
  } else {
    process.stdout.write(renderConfigurationDiagnostics(report));
  }
  if (mode === "write") {
    const paths = await writeConfigurationDiagnostics(repositoryRoot, report);
    console.log(`config.diagnostics.path=${paths.latest}`);
    console.log("config.diagnostics.write=ok");
  }
  if (mode === "check" && diagnosticsHasStructuralErrors(report)) process.exitCode = 1;
  if (mode === "cutover" && !cutoverIsReady(report)) process.exitCode = 2;
}
