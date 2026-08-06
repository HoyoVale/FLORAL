import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ResolvedConfigurationAuthority } from "./config-authority.js";
import { safeConfigurationJson } from "./config-authority.js";

export interface EffectiveConfigBundlePaths {
  directory: string;
  requested: string;
  effective: string;
  manifest: string;
}

export async function writeEffectiveConfigBundle(
  repositoryRoot: string,
  authority: ResolvedConfigurationAuthority,
): Promise<EffectiveConfigBundlePaths> {
  const directory = join(repositoryRoot, "data/config/effective");
  const paths: EffectiveConfigBundlePaths = {
    directory,
    requested: join(directory, "floral-requested.json"),
    effective: join(directory, "floral-effective.json"),
    manifest: join(directory, "manifest.json"),
  };

  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await Promise.all([
    writePrivateJson(paths.requested, authority.requested),
    writePrivateJson(paths.effective, authority.effective),
    writePrivateJson(paths.manifest, {
      authorityVersion: authority.authorityVersion,
      configPath: authority.configPath,
      requestedFingerprint: authority.requestedFingerprint,
      effectiveFingerprint: authority.effectiveFingerprint,
      environmentOverrideKeys: authority.environmentOverrideKeys,
      lockedPaths: authority.lockedPaths,
      safeSnapshot: safeConfigurationJson(authority),
    }),
  ]);
  return paths;
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
