import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ConfigurationDiagnosticsReport } from "../diagnostics/config-diagnostics.js";
import { safeConfigurationDiagnosticsJson } from "../diagnostics/config-diagnostics.js";

export interface ConfigurationDiagnosticsPaths {
  directory: string;
  latest: string;
}

export async function writeConfigurationDiagnostics(
  repositoryRoot: string,
  report: ConfigurationDiagnosticsReport,
): Promise<ConfigurationDiagnosticsPaths> {
  const directory = join(repositoryRoot, "data/config/diagnostics");
  const latest = join(directory, "latest.json");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await writePrivateJson(latest, safeConfigurationDiagnosticsJson(report));
  return { directory, latest };
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
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
