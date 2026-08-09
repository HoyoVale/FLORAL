import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  rename,
  rm,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolveConfigurationAuthority } from "../src/config/federation/config-authority.js";
import { loadProjectEnv } from "../src/config/load-project-env.js";
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
} from "../src/skills/external-skill-registry.js";

loadProjectEnv();
const repositoryRoot = process.cwd();
const authority = await resolveConfigurationAuthority({
  repositoryRoot,
  environment: process.env,
});
const paths = resolveExternalSkillRegistryPaths(
  repositoryRoot,
  authority.effective.floral.data_dir,
);

const [command = "list", idValue, ...rest] = process.argv.slice(2);

switch (command) {
  case "list":
    await listSkills();
    break;
  case "doctor":
    await doctor();
    break;
  case "install":
    await installOrUpdate("install", requireCatalogId(idValue), parseRef(rest));
    break;
  case "update":
    await installOrUpdate("update", requireCatalogId(idValue), parseRef(rest));
    break;
  case "enable":
    await setEnabled(requireCatalogId(idValue), true);
    break;
  case "disable":
    await setEnabled(requireCatalogId(idValue), false);
    break;
  case "remove":
    await removeSkill(requireCatalogId(idValue));
    break;
  default:
    usage(`Unknown command: ${command}`);
}

async function listSkills(): Promise<void> {
  const registry = await readExternalSkillRegistry(paths);
  const byId = new Map(registry.packages.map((entry) => [entry.id, entry] as const));
  for (const catalog of Object.values(CURATED_EXTERNAL_SKILLS)) {
    const installed = byId.get(catalog.id);
    if (!installed) {
      process.stdout.write(`${catalog.id}\tinstalled=false\tsource=${catalog.repository}\n`);
      continue;
    }
    process.stdout.write([
      `${catalog.id}`,
      "installed=true",
      `enabled=${String(installed.enabled)}`,
      `ref=${installed.ref}`,
      `commit=${installed.commit}`,
      `source=${installed.repository}`,
    ].join("\t") + "\n");
  }
}

async function doctor(): Promise<void> {
  const roots = await resolveEnabledExternalSkillRoots({
    repositoryRoot,
    dataDir: authority.effective.floral.data_dir,
    strict: true,
  });
  process.stdout.write(`external_skills.status=ok\nexternal_skills.enabled_roots=${String(roots.length)}\n`);
  for (const root of roots) process.stdout.write(`external_skills.root=${root}\n`);
}

async function installOrUpdate(
  mode: "install" | "update",
  id: ExternalSkillCatalogId,
  refOverride: string | undefined,
): Promise<void> {
  const catalog = CURATED_EXTERNAL_SKILLS[id];
  const registry = await readExternalSkillRegistry(paths);
  const existing = registry.packages.find((entry) => entry.id === id);
  if (mode === "install" && existing) {
    throw new Error(`${id} is already installed; use update instead`);
  }
  if (mode === "update" && !existing) {
    throw new Error(`${id} is not installed; use install first`);
  }

  const ref = validateGitRef(refOverride ?? existing?.ref ?? catalog.defaultRef);
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  await mkdir(paths.packagesRoot, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(paths.root, `.staging-${id}-`));
  const checkout = join(staging, "repository");
  const finalPackage = join(paths.packagesRoot, id);
  const backupPackage = `${finalPackage}.backup-${String(process.pid)}-${Date.now().toString(36)}`;
  let oldMoved = false;
  let newMoved = false;

  try {
    process.stdout.write(`external_skills.${mode}=fetching:${id}@${ref}\n`);
    await runGit([
      "clone",
      "--filter=blob:none",
      "--depth", "1",
      "--single-branch",
      "--branch", ref,
      catalog.repository,
      checkout,
    ]);
    const origin = (await gitOutput(["-C", checkout, "remote", "get-url", "origin"])).trim();
    if (origin !== catalog.repository) {
      throw new Error(`Unexpected git origin for ${id}: ${origin}`);
    }
    const commit = (await gitOutput(["-C", checkout, "rev-parse", "HEAD"])).trim().toLowerCase();
    if (!/^[0-9a-f]{40}$/u.test(commit)) {
      throw new Error(`Unable to resolve a full commit for ${id}`);
    }
    const validated = await validateExternalSkillCheckout(checkout, catalog.skillSubdir);
    const willEnable = existing?.enabled ?? true;
    if (willEnable) {
      await assertNoEnabledSkillNameCollisions(id, validated.skillNames, registry);
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
      await writeExternalSkillRegistry(paths, next);
    } catch (error) {
      if (newMoved) await rm(finalPackage, { recursive: true, force: true }).catch(() => undefined);
      if (oldMoved) await rename(backupPackage, finalPackage).catch(() => undefined);
      throw error;
    }

    if (oldMoved) await rm(backupPackage, { recursive: true, force: true });
    process.stdout.write([
      `external_skills.${mode}=ok`,
      `id=${id}`,
      `ref=${ref}`,
      `commit=${commit}`,
      `skills=${String(validated.skillNames.length)}`,
      "restart_required=true",
    ].join(" ") + "\n");
    process.stdout.write(
      "note=Third-party Skills are untrusted instructions. FLORAL shares only the validated Skill root; normal sandbox and approval policy still apply.\n",
    );
  } finally {
    if (!newMoved) await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    if (oldMoved) await rm(backupPackage, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function setEnabled(id: ExternalSkillCatalogId, enabled: boolean): Promise<void> {
  const registry = await readExternalSkillRegistry(paths);
  const existing = registry.packages.find((entry) => entry.id === id);
  if (!existing) throw new Error(`${id} is not installed`);
  if (existing.enabled === enabled) {
    process.stdout.write(`external_skills.${enabled ? "enable" : "disable"}=unchanged:${id}\n`);
    return;
  }
  if (enabled) {
    const checkout = join(paths.packagesRoot, id, "repository");
    const validated = await validateExternalSkillCheckout(checkout, existing.skillSubdir);
    await assertNoEnabledSkillNameCollisions(id, validated.skillNames, registry);
  }
  const next: ExternalSkillRegistry = {
    version: EXTERNAL_SKILL_REGISTRY_VERSION,
    packages: registry.packages.map((entry) =>
      entry.id === id
        ? { ...entry, enabled, updatedAt: new Date().toISOString() }
        : entry
    ),
  };
  await writeExternalSkillRegistry(paths, next);
  process.stdout.write(`external_skills.${enabled ? "enable" : "disable"}=ok:${id} restart_required=true\n`);
}

async function removeSkill(id: ExternalSkillCatalogId): Promise<void> {
  const registry = await readExternalSkillRegistry(paths);
  const existing = registry.packages.find((entry) => entry.id === id);
  if (!existing) throw new Error(`${id} is not installed`);
  const finalPackage = join(paths.packagesRoot, id);
  const backupPackage = `${finalPackage}.remove-${String(process.pid)}-${Date.now().toString(36)}`;
  await rename(finalPackage, backupPackage);
  try {
    await writeExternalSkillRegistry(paths, {
      version: EXTERNAL_SKILL_REGISTRY_VERSION,
      packages: registry.packages.filter((entry) => entry.id !== id),
    });
  } catch (error) {
    await rename(backupPackage, finalPackage).catch(() => undefined);
    throw error;
  }
  await rm(backupPackage, { recursive: true, force: true });
  process.stdout.write(`external_skills.remove=ok:${id} restart_required=true\n`);
}

async function assertNoEnabledSkillNameCollisions(
  candidateId: ExternalSkillCatalogId,
  candidateNames: string[],
  registry: ExternalSkillRegistry,
): Promise<void> {
  const occupied = new Map<string, string>();
  const builtInRoot = resolve(repositoryRoot, "skills");
  for (const name of await discoverSkillNames(builtInRoot)) occupied.set(name, "FLORAL builtin");

  for (const entry of registry.packages) {
    if (!entry.enabled || entry.id === candidateId) continue;
    const checkout = join(paths.packagesRoot, entry.id, "repository");
    const validated = await validateExternalSkillCheckout(checkout, entry.skillSubdir);
    for (const name of validated.skillNames) occupied.set(name, entry.id);
  }

  const collisions = candidateNames
    .filter((name) => occupied.has(name))
    .map((name) => `${name} (${occupied.get(name)})`);
  if (collisions.length > 0) {
    throw new Error(`External Skill name collision: ${collisions.join(", ")}`);
  }
}

function requireCatalogId(value: string | undefined): ExternalSkillCatalogId {
  if (!value || !(value in CURATED_EXTERNAL_SKILLS)) {
    usage(`Unknown or missing external Skill id: ${String(value ?? "")}`);
  }
  return value as ExternalSkillCatalogId;
}

function parseRef(args: string[]): string | undefined {
  if (args.length === 0) return undefined;
  if (args.length !== 2 || args[0] !== "--ref" || !args[1]) {
    usage("Expected optional --ref <git-ref>");
  }
  return validateGitRef(args[1]);
}

async function runGit(args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn("git", args, {
      cwd: repositoryRoot,
      stdio: "inherit",
      shell: false,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`git ${args[0] ?? "command"} failed (${signal ?? String(code)})`));
    });
  });
}

async function gitOutput(args: string[]): Promise<string> {
  return await new Promise<string>((resolvePromise, reject) => {
    const child = spawn("git", args, {
      cwd: repositoryRoot,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(`git ${args[0] ?? "command"} failed: ${stderr.trim().slice(0, 500)}`));
    });
  });
}

function usage(message?: string): never {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write([
    "Usage:",
    "  pnpm skills:external list",
    "  pnpm skills:external doctor",
    "  pnpm skills:external install superpowers [--ref main]",
    "  pnpm skills:external update superpowers [--ref main]",
    "  pnpm skills:external enable superpowers",
    "  pnpm skills:external disable superpowers",
    "  pnpm skills:external remove superpowers",
  ].join("\n") + "\n");
  process.exitCode = 2;
  throw new Error("Invalid external Skill command");
}
