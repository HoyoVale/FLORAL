import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize, resolve, sep } from "node:path";
import type { NativeConfigBundle } from "../adapters/native-config-types.js";
import { safeNativeBundleJson } from "../adapters/native-config-types.js";

export interface NativeConfigBundlePaths {
  directory: string;
  manifest: string;
  artifacts: string[];
}

export async function writeNativeConfigBundle(
  repositoryRoot: string,
  bundle: NativeConfigBundle,
): Promise<NativeConfigBundlePaths> {
  const parent = resolve(repositoryRoot, "data/config");
  const directory = join(parent, "native");
  const nonce = `${String(process.pid)}-${Date.now().toString(36)}`;
  const staging = join(parent, `.native-staging-${nonce}`);
  const backup = join(parent, `.native-backup-${nonce}`);

  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700);
  await rm(staging, { recursive: true, force: true });
  await rm(backup, { recursive: true, force: true });
  await mkdir(staging, { recursive: false, mode: 0o700 });
  await chmod(staging, 0o700);

  try {
    for (const artifact of bundle.artifacts) {
      const path = safeArtifactPath(staging, artifact.relativePath);
      await writePrivateText(path, artifact.content);
    }
    await writePrivateText(
      join(staging, "manifest.json"),
      `${JSON.stringify(safeNativeBundleJson(bundle), null, 2)}\n`,
    );

    const hadPrevious = await moveExistingDirectory(directory, backup);
    try {
      await rename(staging, directory);
    } catch (error) {
      if (hadPrevious) await rename(backup, directory).catch(() => undefined);
      throw error;
    }
    await rm(backup, { recursive: true, force: true });
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }

  return {
    directory,
    manifest: join(directory, "manifest.json"),
    artifacts: bundle.artifacts
      .map((artifact) => safeArtifactPath(directory, artifact.relativePath))
      .sort(),
  };
}

async function moveExistingDirectory(source: string, destination: string): Promise<boolean> {
  try {
    await rename(source, destination);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function safeArtifactPath(root: string, relativePath: string): string {
  const normalized = normalize(relativePath).replaceAll("\\", "/");
  if (
    normalized.startsWith("../")
    || normalized === ".."
    || normalized.startsWith("/")
    || normalized.includes("/../")
  ) {
    throw new Error(`Unsafe native configuration artifact path: ${relativePath}`);
  }
  const path = resolve(root, normalized);
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (path !== root && !path.startsWith(rootPrefix)) {
    throw new Error(`Native configuration artifact escaped output root: ${relativePath}`);
  }
  return path;
}

async function writePrivateText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporary = `${path}.tmp-${String(process.pid)}-${Date.now().toString(36)}`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
