import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "../src/config/load-project-env.js";
import {
  buildConfigurationInventory,
  inventoryHasErrors,
  renderConfigurationInventory,
} from "../src/config/inventory/config-inventory.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadProjectEnv(join(repositoryRoot, ".env"));

const flags = new Set(process.argv.slice(2));
const knownFlags = new Set(["--check", "--json", "--write", "--no-runtime"]);
for (const flag of flags) {
  if (!knownFlags.has(flag)) {
    throw new Error(`Unknown config inventory option: ${flag}`);
  }
}

const inventory = await buildConfigurationInventory({
  repositoryRoot,
  includeRuntimeProbes: !flags.has("--no-runtime"),
  codexCommand: process.env.CODEX_COMMAND?.trim() || "codex",
  peekabooCommand: process.env.PEEKABOO_COMMAND?.trim() || "peekaboo",
});

if (flags.has("--write")) {
  const path = join(repositoryRoot, "data/config/inventory/latest.json");
  await writePrivateJson(path, inventory);
  console.log(`config.inventory.path=${path}`);
}

if (flags.has("--json")) {
  process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
} else {
  process.stdout.write(renderConfigurationInventory(inventory));
}

if (flags.has("--check") && inventoryHasErrors(inventory)) {
  process.exitCode = 1;
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = `${path}.tmp-${String(process.pid)}-${Date.now().toString(36)}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}
