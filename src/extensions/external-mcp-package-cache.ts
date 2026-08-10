import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import {
  CURATED_EXTERNAL_MCP,
  externalMcpCatalogManifestIntegrity,
  type ExternalMcpCatalogId,
  type ExternalMcpCatalogEntry,
  type ExternalMcpRegistry,
} from "./external-mcp-registry.js";

interface PackageMarker {
  schemaVersion: 1;
  id: ExternalMcpCatalogId;
  packageName: string;
  packageVersion: string;
  packageIntegrity: string;
  manifestIntegrity: string;
  contentIntegrity: string;
}

export interface ExternalMcpPackageCacheOptions {
  repositoryRoot: string;
  dataDir: string;
  install?: ((directory: string, catalog: ExternalMcpCatalogEntry) => Promise<void>) | undefined;
}

export class ExternalMcpPackageCache {
  readonly #packagesRoot: string;
  readonly #install: (directory: string, catalog: ExternalMcpCatalogEntry) => Promise<void>;

  constructor(options: ExternalMcpPackageCacheOptions) {
    this.#packagesRoot = resolve(
      options.repositoryRoot,
      options.dataDir,
      "external-extensions",
      "packages",
    );
    this.#install = options.install ?? installWithNpm;
  }

  async reconcile(registry: ExternalMcpRegistry): Promise<void> {
    for (const entry of registry.packages) {
      if (!entry.enabled) continue;
      await this.ensure(entry.id);
    }
  }

  async ensure(id: ExternalMcpCatalogId): Promise<void> {
    const catalog = CURATED_EXTERNAL_MCP[id];
    if (!catalog.runtimePackage) return;
    const finalDirectory = join(this.#packagesRoot, id);
    if (await this.#valid(finalDirectory, catalog)) return;

    await mkdir(this.#packagesRoot, { recursive: true, mode: 0o700 });
    await chmod(this.#packagesRoot, 0o700).catch(() => undefined);
    const staging = await mkdtemp(join(this.#packagesRoot, `.staging-${id}-`));
    const backup = `${finalDirectory}.backup-${String(process.pid)}-${Date.now().toString(36)}`;
    let oldMoved = false;
    let newMoved = false;
    try {
      await this.#install(staging, catalog);
      await this.#writeMarker(staging, catalog);
      if (!await this.#valid(staging, catalog)) {
        throw new Error(`Managed MCP package validation failed for ${id}`);
      }
      try {
        await rename(finalDirectory, backup);
        oldMoved = true;
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      await rename(staging, finalDirectory);
      newMoved = true;
      if (oldMoved) await rm(backup, { recursive: true, force: true });
    } catch (error) {
      if (newMoved) await rm(finalDirectory, { recursive: true, force: true }).catch(() => undefined);
      if (oldMoved) await rename(backup, finalDirectory).catch(() => undefined);
      throw error;
    } finally {
      if (!newMoved) await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      if (oldMoved) await rm(backup, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async remove(id: ExternalMcpCatalogId): Promise<void> {
    await rm(join(this.#packagesRoot, id), { recursive: true, force: true });
  }

  async #writeMarker(
    directory: string,
    catalog: ExternalMcpCatalogEntry,
  ): Promise<void> {
    const runtimePackage = catalog.runtimePackage!;
    const marker: PackageMarker = {
      schemaVersion: 1,
      id: catalog.id,
      packageName: runtimePackage.name,
      packageVersion: runtimePackage.version,
      packageIntegrity: runtimePackage.integrity,
      manifestIntegrity: externalMcpCatalogManifestIntegrity(catalog.id),
      contentIntegrity: await directoryIntegrity(
        join(directory, "node_modules", runtimePackage.name),
      ),
    };
    const path = join(directory, ".floral-package.json");
    await writeFile(path, `${JSON.stringify(marker, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(path, 0o600).catch(() => undefined);
  }

  async #valid(
    directory: string,
    catalog: ExternalMcpCatalogEntry,
  ): Promise<boolean> {
    const runtimePackage = catalog.runtimePackage;
    if (!runtimePackage) return true;
    try {
      const marker = JSON.parse(await readFile(join(directory, ".floral-package.json"), "utf8")) as Partial<PackageMarker>;
      if (
        marker.schemaVersion !== 1
        || marker.id !== catalog.id
        || marker.packageName !== runtimePackage.name
        || marker.packageVersion !== runtimePackage.version
        || marker.packageIntegrity !== runtimePackage.integrity
        || marker.manifestIntegrity !== externalMcpCatalogManifestIntegrity(catalog.id)
      ) return false;

      const packageJson = JSON.parse(
        await readFile(join(directory, "node_modules", runtimePackage.name, "package.json"), "utf8"),
      ) as { name?: unknown; version?: unknown };
      if (packageJson.name !== runtimePackage.name || packageJson.version !== runtimePackage.version) {
        return false;
      }
      if (marker.contentIntegrity !== await directoryIntegrity(
        join(directory, "node_modules", runtimePackage.name),
      )) return false;
      const lock = JSON.parse(await readFile(join(directory, "package-lock.json"), "utf8")) as {
        packages?: Record<string, { version?: unknown; integrity?: unknown }>;
      };
      const locked = lock.packages?.[`node_modules/${runtimePackage.name}`];
      if (locked?.version !== runtimePackage.version || locked.integrity !== runtimePackage.integrity) {
        return false;
      }
      const entrypoint = resolve(directory, runtimePackage.entrypoint);
      if (!isInside(directory, entrypoint)) return false;
      const stat = await lstat(entrypoint);
      return stat.isFile() && !stat.isSymbolicLink();
    } catch {
      return false;
    }
  }
}

async function directoryIntegrity(root: string): Promise<string> {
  const canonicalRoot = resolve(root);
  const files: string[] = [];
  const queue = [canonicalRoot];
  while (queue.length > 0) {
    const current = queue.pop()!;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const child = join(current, entry.name);
      const stat = await lstat(child);
      if (stat.isSymbolicLink()) throw new Error("Managed MCP package symlink is forbidden");
      if (stat.isDirectory()) queue.push(child);
      else if (stat.isFile()) files.push(child);
      else throw new Error("Managed MCP package entry type is forbidden");
    }
  }
  files.sort((a, b) => relative(canonicalRoot, a).localeCompare(relative(canonicalRoot, b)));
  const hash = createHash("sha256");
  for (const file of files) {
    const name = relative(canonicalRoot, file).split(sep).join("/");
    const bytes = await readFile(file);
    hash.update(`${name.length}:${name}:${bytes.byteLength}:`, "utf8");
    hash.update(bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}

async function installWithNpm(
  directory: string,
  catalog: ExternalMcpCatalogEntry,
): Promise<void> {
  const runtimePackage = catalog.runtimePackage;
  if (!runtimePackage) return;
  await runProcess(
    process.platform === "win32" ? "npm.cmd" : "npm",
    [
      "install",
      "--prefix", directory,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=true",
      "--save-exact",
      `${runtimePackage.name}@${runtimePackage.version}`,
    ],
  );
}

async function runProcess(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: "ignore",
      shell: process.platform === "win32",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`Managed package install failed (${signal ?? String(code)})`));
    });
  });
}

function isInside(root: string, candidate: string): boolean {
  const normalized = `${resolve(root)}${process.platform === "win32" ? "\\" : "/"}`;
  return candidate === resolve(root) || candidate.startsWith(normalized);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}
