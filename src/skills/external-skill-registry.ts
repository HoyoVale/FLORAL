import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";

export const EXTERNAL_SKILL_REGISTRY_VERSION = 2 as const;

export const CURATED_EXTERNAL_SKILLS = {
  superpowers: {
    id: "superpowers",
    repository: "https://github.com/obra/superpowers.git",
    branch: "main",
    pinnedCommit: "44c9b2d6e889982ac18c27d05a19fefe335194e1",
    defaultRef: "44c9b2d6e889982ac18c27d05a19fefe335194e1",
    skillSubdir: "skills",
  },
} as const;

export type ExternalSkillCatalogId = keyof typeof CURATED_EXTERNAL_SKILLS;

export interface ExternalSkillRegistryEntry {
  id: ExternalSkillCatalogId;
  repository: string;
  ref: string;
  commit: string;
  integrity?: string | undefined;
  enabled: boolean;
  skillSubdir: string;
  installedAt: string;
  updatedAt: string;
}

export interface ExternalSkillRegistry {
  version: typeof EXTERNAL_SKILL_REGISTRY_VERSION;
  packages: ExternalSkillRegistryEntry[];
}

export interface ExternalSkillRegistryPaths {
  root: string;
  registryPath: string;
  packagesRoot: string;
}

export interface ValidatedExternalSkillCheckout {
  checkoutRoot: string;
  skillRoot: string;
  skillNames: string[];
  integrity: string;
}

export function resolveExternalSkillRegistryPaths(
  repositoryRoot: string,
  dataDir: string,
): ExternalSkillRegistryPaths {
  const root = resolve(repositoryRoot, dataDir, "external-skills");
  return {
    root,
    registryPath: join(root, "registry.json"),
    packagesRoot: join(root, "packages"),
  };
}

export async function readExternalSkillRegistry(
  paths: ExternalSkillRegistryPaths,
): Promise<ExternalSkillRegistry> {
  let raw: string;
  try {
    raw = await readFile(paths.registryPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: EXTERNAL_SKILL_REGISTRY_VERSION, packages: [] };
    }
    throw error;
  }
  return parseExternalSkillRegistry(JSON.parse(raw) as unknown);
}

export async function writeExternalSkillRegistry(
  paths: ExternalSkillRegistryPaths,
  registry: ExternalSkillRegistry,
): Promise<void> {
  const normalized = parseExternalSkillRegistry(registry);
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  await chmod(paths.root, 0o700).catch(() => undefined);
  const temporary = `${paths.registryPath}.tmp-${String(process.pid)}-${Date.now().toString(36)}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await chmod(temporary, 0o600).catch(() => undefined);
    await rename(temporary, paths.registryPath);
    await chmod(paths.registryPath, 0o600).catch(() => undefined);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function validateExternalSkillCheckout(
  checkoutRoot: string,
  skillSubdir: string,
): Promise<ValidatedExternalSkillCheckout> {
  const canonicalCheckout = await canonicalDirectory(checkoutRoot, "External Skill checkout");
  const requestedSkillRoot = resolve(canonicalCheckout, skillSubdir);
  if (!isInside(canonicalCheckout, requestedSkillRoot)) {
    throw new Error("External Skill root escapes its checkout");
  }
  const rootLstat = await lstat(requestedSkillRoot);
  if (rootLstat.isSymbolicLink() || !rootLstat.isDirectory()) {
    throw new Error("External Skill root must be a real directory");
  }
  const canonicalSkillRoot = await realpath(requestedSkillRoot);
  if (!isInside(canonicalCheckout, canonicalSkillRoot)) {
    throw new Error("External Skill root resolves outside its checkout");
  }

  await assertNoSymlinks(canonicalSkillRoot);
  const skillNames = await discoverSkillNames(canonicalSkillRoot);
  if (skillNames.length === 0) {
    throw new Error("External Skill package contains no discoverable SKILL.md files");
  }

  return {
    checkoutRoot: canonicalCheckout,
    skillRoot: canonicalSkillRoot,
    skillNames,
    integrity: await computeSkillTreeIntegrity(canonicalSkillRoot),
  };
}

export async function computeSkillTreeIntegrity(skillRoot: string): Promise<string> {
  const canonicalRoot = await canonicalDirectory(skillRoot, "Skill root");
  const files: string[] = [];
  const queue = [canonicalRoot];
  while (queue.length > 0) {
    const current = queue.pop()!;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const child = join(current, entry.name);
      const stat = await lstat(child);
      if (stat.isSymbolicLink()) {
        throw new Error(`External Skill symlink is forbidden: ${child}`);
      }
      if (stat.isDirectory()) queue.push(child);
      else if (stat.isFile()) files.push(child);
      else throw new Error(`External Skill entry type is forbidden: ${child}`);
    }
  }
  files.sort((left, right) => relative(canonicalRoot, left).localeCompare(relative(canonicalRoot, right)));
  const hash = createHash("sha256");
  for (const file of files) {
    const name = relative(canonicalRoot, file).split(sep).join("/");
    const bytes = await readFile(file);
    hash.update(`${String(Buffer.byteLength(name, "utf8"))}:`, "utf8");
    hash.update(name, "utf8");
    hash.update(`${String(bytes.byteLength)}:`, "utf8");
    hash.update(bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}

export async function discoverSkillNames(skillRoot: string): Promise<string[]> {
  const canonicalRoot = await canonicalDirectory(skillRoot, "Skill root");
  const entries = await readdir(canonicalRoot, { withFileTypes: true });
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const skillFile = join(canonicalRoot, entry.name, "SKILL.md");
    let skillStat;
    try {
      skillStat = await lstat(skillFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!skillStat.isFile() || skillStat.isSymbolicLink()) {
      throw new Error(`Skill metadata is not a regular file: ${skillFile}`);
    }
    const declared = readDeclaredSkillName(await readFile(skillFile, "utf8"));
    names.push(declared ?? entry.name);
  }
  return [...new Set(names)].sort();
}

export async function resolveEnabledExternalSkillRoots(options: {
  repositoryRoot: string;
  dataDir: string;
  strict?: boolean | undefined;
  onWarning?: ((message: string) => void) | undefined;
}): Promise<string[]> {
  const paths = resolveExternalSkillRegistryPaths(options.repositoryRoot, options.dataDir);
  let registry: ExternalSkillRegistry;
  try {
    registry = await readExternalSkillRegistry(paths);
  } catch (error) {
    if (options.strict) throw error;
    options.onWarning?.(`registry:${errorName(error)}`);
    return [];
  }

  const builtInRoot = resolve(options.repositoryRoot, "skills");
  const occupied = new Set<string>();
  try {
    for (const name of await discoverSkillNames(builtInRoot)) occupied.add(name);
  } catch (error) {
    if (options.strict) throw error;
    options.onWarning?.(`builtin:${errorName(error)}`);
  }

  const roots: string[] = [];
  for (const entry of registry.packages) {
    if (!entry.enabled) continue;
    try {
      const checkout = join(paths.packagesRoot, entry.id, "repository");
      const validated = await validateExternalSkillCheckout(checkout, entry.skillSubdir);
      if (entry.integrity && validated.integrity !== entry.integrity) {
        throw new Error(`External Skill integrity mismatch: ${entry.id}`);
      }
      const collisions = validated.skillNames.filter((name) => occupied.has(name));
      if (collisions.length > 0) {
        throw new Error(`Skill name collision: ${collisions.join(", ")}`);
      }
      for (const name of validated.skillNames) occupied.add(name);
      roots.push(validated.skillRoot);
    } catch (error) {
      if (options.strict) throw error;
      options.onWarning?.(`${entry.id}:${errorName(error)}`);
    }
  }
  return roots;
}

function parseExternalSkillRegistry(value: unknown): ExternalSkillRegistry {
  if (!isRecord(value) || (value.version !== 1 && value.version !== EXTERNAL_SKILL_REGISTRY_VERSION)) {
    throw new Error("Unsupported external Skill registry version");
  }
  if (!Array.isArray(value.packages)) {
    throw new Error("External Skill registry packages must be an array");
  }
  const packages = value.packages.map(parseExternalSkillRegistryEntry);
  const ids = new Set<string>();
  for (const entry of packages) {
    if (ids.has(entry.id)) throw new Error(`Duplicate external Skill id: ${entry.id}`);
    ids.add(entry.id);
  }
  return { version: EXTERNAL_SKILL_REGISTRY_VERSION, packages };
}

function parseExternalSkillRegistryEntry(value: unknown): ExternalSkillRegistryEntry {
  if (!isRecord(value)) throw new Error("Invalid external Skill registry entry");
  const id = readCatalogId(value.id);
  const catalog = CURATED_EXTERNAL_SKILLS[id];
  const repository = readString(value.repository, "repository");
  const ref = validateGitRef(readString(value.ref, "ref"));
  const commit = readString(value.commit, "commit");
  const integrity = value.integrity === undefined
    ? undefined
    : readIntegrity(value.integrity, id);
  const skillSubdir = readString(value.skillSubdir, "skillSubdir");
  const installedAt = readIsoTimestamp(value.installedAt, "installedAt");
  const updatedAt = readIsoTimestamp(value.updatedAt, "updatedAt");
  if (repository !== catalog.repository || skillSubdir !== catalog.skillSubdir) {
    throw new Error(`External Skill source drift for ${id}`);
  }
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error(`External Skill commit is invalid for ${id}`);
  }
  if (typeof value.enabled !== "boolean") {
    throw new Error(`External Skill enabled flag is invalid for ${id}`);
  }
  return {
    id,
    repository,
    ref,
    commit,
    ...(integrity ? { integrity } : {}),
    enabled: value.enabled,
    skillSubdir,
    installedAt,
    updatedAt,
  };
}

function readIntegrity(value: unknown, id: string): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`External Skill integrity is invalid for ${id}`);
  }
  return value;
}

export function validateGitRef(value: string): string {
  const ref = value.trim();
  if (
    !ref
    || ref.length > 160
    || ref.startsWith("-")
    || ref.includes("..")
    || /[\\\s~^:?*[\]\u0000-\u001F\u007F]/u.test(ref)
  ) {
    throw new Error("External Skill git ref is invalid");
  }
  return ref;
}

function readCatalogId(value: unknown): ExternalSkillCatalogId {
  if (typeof value !== "string" || !(value in CURATED_EXTERNAL_SKILLS)) {
    throw new Error(`Unknown external Skill id: ${String(value)}`);
  }
  return value as ExternalSkillCatalogId;
}

function readString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u001F\u007F]/u.test(value)) {
    throw new Error(`External Skill ${label} is invalid`);
  }
  return value.trim();
}

function readIsoTimestamp(value: unknown, label: string): string {
  const text = readString(value, label);
  if (!Number.isFinite(Date.parse(text))) {
    throw new Error(`External Skill ${label} is invalid`);
  }
  return text;
}

function readDeclaredSkillName(text: string): string | undefined {
  if (!text.startsWith("---")) return undefined;
  const lines = text.split(/\r?\n/u);
  if (lines[0] !== "---") return undefined;
  for (let index = 1; index < Math.min(lines.length, 80); index += 1) {
    const line = lines[index] ?? "";
    if (line === "---") return undefined;
    const match = /^name:\s*["']?([a-z0-9][a-z0-9-]{0,63})["']?\s*$/iu.exec(line);
    if (match?.[1]) return match[1].toLowerCase();
  }
  return undefined;
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  const requested = resolve(path);
  const stat = await lstat(requested);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a real directory`);
  }
  return await realpath(requested);
}

async function assertNoSymlinks(root: string): Promise<void> {
  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  let visited = 0;
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (current.depth > 16) throw new Error("External Skill tree exceeds maximum depth");
    const entries = await readdir(current.path, { withFileTypes: true });
    for (const entry of entries) {
      visited += 1;
      if (visited > 20_000) throw new Error("External Skill tree exceeds maximum entry count");
      const child = join(current.path, entry.name);
      const stat = await lstat(child);
      if (stat.isSymbolicLink()) {
        throw new Error(`External Skill symlink is forbidden: ${child}`);
      }
      if (stat.isDirectory()) queue.push({ path: child, depth: current.depth + 1 });
    }
  }
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.includes(`..${sep}`));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.message.replace(/[\r\n]+/gu, " ").slice(0, 240) : "Error";
}
