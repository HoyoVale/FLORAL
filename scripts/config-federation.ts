import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "../src/config/load-project-env.js";
import {
  renderConfigurationAuthority,
  resolveConfigurationAuthority,
  safeConfigurationJson,
} from "../src/config/federation/config-authority.js";
import { writeEffectiveConfigBundle } from "../src/config/federation/private-config-writer.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadProjectEnv(join(repositoryRoot, ".env"));

const args = process.argv.slice(2);
const mode = args[0] ?? "show";
const supportedModes = new Set(["validate", "show", "json", "write"]);
if (!supportedModes.has(mode)) throw new Error(`Unknown configuration federation mode: ${mode}`);

const configFlagIndex = args.indexOf("--config");
const configPath = configFlagIndex >= 0 ? args[configFlagIndex + 1] : undefined;
if (configFlagIndex >= 0 && !configPath) throw new Error("--config requires a path");
const unknownArguments = args.filter((argument, index) => (
  index !== 0
  && argument !== "--config"
  && index !== configFlagIndex + 1
));
if (unknownArguments.length > 0) {
  throw new Error(`Unknown configuration federation arguments: ${unknownArguments.join(", ")}`);
}

const authority = await resolveConfigurationAuthority({
  repositoryRoot,
  ...(configPath ? { configPath } : {}),
  environment: process.env,
});

if (mode === "json") {
  process.stdout.write(`${JSON.stringify(safeConfigurationJson(authority), null, 2)}\n`);
} else if (mode === "write") {
  const paths = await writeEffectiveConfigBundle(repositoryRoot, authority);
  process.stdout.write(renderConfigurationAuthority(authority));
  console.log(`config.effective.directory=${paths.directory}`);
  console.log("config.effective.write=ok");
} else {
  process.stdout.write(renderConfigurationAuthority(authority));
  if (mode === "validate") console.log("config.validate=ok");
}
