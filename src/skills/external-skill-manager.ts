import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  rename,
  rm,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  CURATED_EXTERNAL_SKILLS,
  EXTERNAL_SKILL_REGISTRY_VERSION,
  discoverSkillNames,
  readExternalSkillRegistry,
  resolveEnabledExternalSkillRoots,
  resolveExternalSkillRegistryPaths,
  validateExternalSkillCheckout,
  validateGitRef,
  writeExternalSkillRegistry,
  type ExternalSkillCatalogId,
  type ExternalSkillRegistry,
  type ExternalSkillRegistryEntry,
} from "./external-skill-registry.js";

export type ExternalSkillMutationAction =
  | "install"
  | "update"
  | "enable"
  | "disable"
  | "remove";

export interface ExternalSkillMutationRequest {
  action: ExternalSkillMutationAction;
  id: string;
  ref?: string | undefined;
}

export interface ExternalSkillManagementResult {
  changed: boolean;
  message: string;
}

export interface ExternalSkillPackageStatus {
  id: ExternalSkillCatalogId;
  installed: boolean;
  enabled: boolean;
  repository: string;
  ref?: string | undefined;
  commit?: string | undefined;
}

export interface ExternalSkillManagerOptions {
  repositoryRoot: string;
  dataDir: string;
}

export class ExternalSkillManager {
  readonly #repositoryRoot: string;
  readonly #dataDir: string;
  readonly #paths: ReturnType<typeof resolveExternalSkillRegistryPaths>;

  constructor(options: ExternalSkillManagerOptions) {
    this.#repositoryRoot = resolve(options.repositoryRoot);
    this.#dataDir = options.dataDir;
    this.#paths = resolveExternalSkillRegistryPaths(
      this.#repositoryRoot,
      this.#dataDir,
    );
  }

  async list(): Promise<ExternalSkillPackageStatus[]> {
    const registry = await readExternalSkillRegistry(this.#paths);
    const byId = new Map(
      registry.packages.map((entry) => [entry.id, entry] as const),
    );
    return Object.values(CURATED_EXTERNAL_SKILLS).map((catalog) => {
      const installed = byId.get(catalog.id);
      return {
        id: catalog.id,
        installed: Boolean(installed),
        enabled: installed?.enabled ?? false,
        repository: catalog.repository,
        ...(installed ? { ref: installed.ref, commit: installed.commit } : {}),
      };
    });
  }

  async listText(): Promise<string> {
    const packages = await this.list();
    return [
      `external_skill_catalog.count=${String(packages.length)}`,
      ...packages.map((entry) => [
        `id=${entry.id}`,
        `installed=${String(entry.installed)}`,
        `enabled=${String(entry.enabled)}`,
        ...(entry.ref ? [`ref=${entry.ref}`] : []),
        ...(entry.commit ? [`commit=${entry.commit}`] : []),
        `source=${entry.repository}`,
      ].join(" ")),
    ].join("\n");
  }

  async enabledRoots(strict = true): Promise<string[]> {
    return await resolveEnabledExternalSkillRoots({
      repositoryRoot: this.#repositoryRoot,
      dataDir: this.#dataDir,
      strict,
    });
  }

  async manage(
    request: ExternalSkillMutationRequest,
  ): Promise<ExternalSkillManagementResult> {
    const id = requireCatalogId(request.id);
    switch (request.action) {
      case "install":
      case "update":
        return await this.#installOrUpdate(
          request.action,
          id,
          request.ref,
        );
      case "enable":
        return await this.#setEnabled(id, true);
      case "disable":
        return await this.#setEnabled(id, false);
      case "remove":
        return await this.#remove(id);
    }
    throw new Error("Unsupported external Skill action");
  }

  async #installOrUpdate(
    mode: "install" | "update",
    id: ExternalSkillCatalogId,
    refOverride: string | undefined,
  ): Promise<ExternalSkillManagementResult> {
    const catalog = CURATED_EXTERNAL_SKILLS[id];
    const registry = await readExternalSkillRegistry(this.#paths);
    const existing = registry.packages.find((entry) => entry.id === id);
    if (mode === "install" && existing) {
      throw new Error(`${id} is already installed; use update instead`);
    }
    if (mode === "update" && !existing) {
      throw new Error(`${id} is not installed; use install first`);
    }

    const ref = validateGitRef(
      refOverride ?? existing?.ref ?? catalog.defaultRef,
    );
    await mkdir(this.#paths.root, { recursive: true, mode: 0o700 });
    await mkdir(this.#paths.packagesRoot, { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(
      join(this.#paths.root, `.staging-${id}-`),
    );
    const checkout = join(staging, "repository");
    const finalPackage = join(this.#paths.packagesRoot, id);
    const backupPackage =
      `${finalPackage}.backup-${String(process.pid)}-${Date.now().toString(36)}`;
    let oldMoved = false;
    let newMoved = false;

    try {
      await runGit(this.#repositoryRoot, [
        "clone",
        "--filter=blob:none",
        "--depth", "1",
        "--single-branch",
        "--branch", ref,
        catalog.repository,
        checkout,
      ]);

      const origin = (
        await gitOutput(this.#repositoryRoot, [
          "-C", checkout, "remote", "get-url", "origin",
        ])
      ).trim();
      if (origin !== catalog.repository) {
        throw new Error(`Unexpected git origin for ${id}: ${origin}`);
      }

      const commit = (
        await gitOutput(this.#repositoryRoot, [
          "-C", checkout, "rev-parse", "HEAD",
        ])
      ).trim().toLowerCase();
      if (!/^[0-9a-f]{40}$/u.test(commit)) {
        throw new Error(`Unable to resolve a full commit for ${id}`);
      }

      const validated = await validateExternalSkillCheckout(
        checkout,
        catalog.skillSubdir,
      );
      const willEnable = existing?.enabled ?? true;
      if (willEnable) {
        await this.#assertNoEnabledSkillNameCollisions(
          id,
          validated.skillNames,
          registry,
        );
      }

      if (existing) {
        await rename(finalPackage, backupPackage);
        oldMoved = true;
      }
      await rename(staging, finalPackage);
      newMoved = true;

      const now = new Date().toISOString();
      const entry: ExternalSkillRegistryEntry = {
        id,
        repository: catalog.repository,
        ref,
        commit,
        enabled: willEnable,
        skillSubdir: catalog.skillSubdir,
        installedAt: existing?.installedAt ?? now,
        updatedAt: now,
      };
      const next: ExternalSkillRegistry = {
        version: EXTERNAL_SKILL_REGISTRY_VERSION,
        packages: [
          ...registry.packages.filter((item) => item.id !== id),
          entry,
        ].sort((a, b) => a.id.localeCompare(b.id)),
      };

      try {
        await writeExternalSkillRegistry(this.#paths, next);
      } catch (error) {
        if (newMoved) {
          await rm(finalPackage, { recursive: true, force: true })
            .catch(() => undefined);
        }
        if (oldMoved) {
          await rename(backupPackage, finalPackage)
            .catch(() => undefined);
        }
        throw error;
      }

      if (oldMoved) {
        await rm(backupPackage, { recursive: true, force: true });
      }

      return {
        changed: true,
        message: [
          `external_skills.${mode}=ok`,
          `id=${id}`,
          `enabled=${String(willEnable)}`,
          `ref=${ref}`,
          `commit=${commit}`,
          `skills=${String(validated.skillNames.length)}`,
        ].join("\n"),
      };
    } finally {
      if (!newMoved) {
        await rm(staging, { recursive: true, force: true })
          .catch(() => undefined);
      }
      if (oldMoved) {
        await rm(backupPackage, { recursive: true, force: true })
          .catch(() => undefined);
      }
    }
  }

  async #setEnabled(
    id: ExternalSkillCatalogId,
    enabled: boolean,
  ): Promise<ExternalSkillManagementResult> {
    const registry = await readExternalSkillRegistry(this.#paths);
    const existing = registry.packages.find((entry) => entry.id === id);
    if (!existing) throw new Error(`${id} is not installed`);

    if (existing.enabled === enabled) {
      return {
        changed: false,
        message: [
          `external_skills.${enabled ? "enable" : "disable"}=unchanged`,
          `id=${id}`,
          `enabled=${String(enabled)}`,
          `ref=${existing.ref}`,
          `commit=${existing.commit}`,
        ].join("\n"),
      };
    }

    let skillCount: number | undefined;
    if (enabled) {
      const checkout = join(
        this.#paths.packagesRoot,
        id,
        "repository",
      );
      const validated = await validateExternalSkillCheckout(
        checkout,
        existing.skillSubdir,
      );
      skillCount = validated.skillNames.length;
      await this.#assertNoEnabledSkillNameCollisions(
        id,
        validated.skillNames,
        registry,
      );
    }

    await writeExternalSkillRegistry(this.#paths, {
      version: EXTERNAL_SKILL_REGISTRY_VERSION,
      packages: registry.packages.map((entry) =>
        entry.id === id
          ? {
              ...entry,
              enabled,
              updatedAt: new Date().toISOString(),
            }
          : entry
      ),
    });

    return {
      changed: true,
      message: [
        `external_skills.${enabled ? "enable" : "disable"}=ok`,
        `id=${id}`,
        `enabled=${String(enabled)}`,
        `ref=${existing.ref}`,
        `commit=${existing.commit}`,
        ...(skillCount !== undefined
          ? [`skills=${String(skillCount)}`]
          : []),
      ].join("\n"),
    };
  }

  async #remove(
    id: ExternalSkillCatalogId,
  ): Promise<ExternalSkillManagementResult> {
    const registry = await readExternalSkillRegistry(this.#paths);
    const existing = registry.packages.find((entry) => entry.id === id);
    if (!existing) throw new Error(`${id} is not installed`);

    const finalPackage = join(this.#paths.packagesRoot, id);
    const backupPackage =
      `${finalPackage}.remove-${String(process.pid)}-${Date.now().toString(36)}`;

    await rename(finalPackage, backupPackage);
    try {
      await writeExternalSkillRegistry(this.#paths, {
        version: EXTERNAL_SKILL_REGISTRY_VERSION,
        packages: registry.packages.filter((entry) => entry.id !== id),
      });
    } catch (error) {
      await rename(backupPackage, finalPackage).catch(() => undefined);
      throw error;
    }
    await rm(backupPackage, { recursive: true, force: true });

    return {
      changed: true,
      message: [
        "external_skills.remove=ok",
        `id=${id}`,
        "enabled=false",
        `ref=${existing.ref}`,
        `commit=${existing.commit}`,
      ].join("\n"),
    };
  }

  async #assertNoEnabledSkillNameCollisions(
    candidateId: ExternalSkillCatalogId,
    candidateNames: string[],
    registry: ExternalSkillRegistry,
  ): Promise<void> {
    const occupied = new Map<string, string>();
    const builtInRoot = resolve(this.#repositoryRoot, "skills");
    for (const name of await discoverSkillNames(builtInRoot)) {
      occupied.set(name, "FLORAL builtin");
    }

    for (const entry of registry.packages) {
      if (!entry.enabled || entry.id === candidateId) continue;
      const checkout = join(
        this.#paths.packagesRoot,
        entry.id,
        "repository",
      );
      const validated = await validateExternalSkillCheckout(
        checkout,
        entry.skillSubdir,
      );
      for (const name of validated.skillNames) {
        occupied.set(name, entry.id);
      }
    }

    const collisions = candidateNames
      .filter((name) => occupied.has(name))
      .map((name) => `${name} (${occupied.get(name)})`);
    if (collisions.length > 0) {
      throw new Error(
        `External Skill name collision: ${collisions.join(", ")}`,
      );
    }
  }
}

function requireCatalogId(value: string): ExternalSkillCatalogId {
  if (!(value in CURATED_EXTERNAL_SKILLS)) {
    throw new Error(`Unknown external Skill id: ${value}`);
  }
  return value as ExternalSkillCatalogId;
}

async function runGit(cwd: string, args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: "ignore",
      shell: false,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(
        new Error(
          `git ${args[0] ?? "command"} failed (${signal ?? String(code)})`,
        ),
      );
    });
  });
}

async function gitOutput(
  cwd: string,
  args: string[],
): Promise<string> {
  return await new Promise<string>((resolvePromise, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolvePromise(stdout);
        return;
      }
      reject(
        new Error(
          `git ${args[0] ?? "command"} failed: ${
            stderr.trim().slice(0, 500)
          }`,
        ),
      );
    });
  });
}
