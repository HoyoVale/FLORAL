import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

export interface WorkspaceProject {
  name: string;
  path: string;
}

export class ProjectWorkspaceRoot {
  #canonicalRoot: string | undefined;

  constructor(private readonly configuredRoot: string) {
    if (!configuredRoot.trim()) {
      throw new Error("Workspace root must not be empty");
    }
  }

  get root(): string {
    return this.#canonicalRoot ?? resolve(this.configuredRoot);
  }

  async initialize(): Promise<void> {
    if (this.#canonicalRoot) return;
    const absolute = resolve(this.configuredRoot);
    const stat = await lstat(absolute).catch(() => undefined);
    if (!stat) {
      throw new Error(`Workspace root does not exist: ${absolute}`);
    }
    if (stat.isSymbolicLink()) {
      throw new Error("Workspace root must not be a symbolic link");
    }
    if (!stat.isDirectory()) {
      throw new Error("Workspace root must be a directory");
    }
    this.#canonicalRoot = await realpath(absolute);
  }

  async listProjects(): Promise<WorkspaceProject[]> {
    this.#ensureInitialized();
    const entries = await readdir(this.#canonicalRoot!, { withFileTypes: true });
    const projects: WorkspaceProject[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const project = await this.resolveExistingProject(entry.name).catch(() => undefined);
      if (project) projects.push(project);
    }
    projects.sort((left, right) => left.name.localeCompare(right.name, undefined, {
      sensitivity: "base",
      numeric: true,
    }));
    return projects;
  }

  async resolveExistingProject(name: string): Promise<WorkspaceProject> {
    this.#ensureInitialized();
    const normalized = normalizeProjectName(name);
    const candidate = resolve(this.#canonicalRoot!, normalized);
    if (dirname(candidate) !== this.#canonicalRoot) {
      throw new Error("Project must be a direct child of the workspace root");
    }

    const stat = await lstat(candidate).catch(() => undefined);
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Project not found: ${normalized}`);
    }
    const canonical = await realpath(candidate);
    if (dirname(canonical) !== this.#canonicalRoot) {
      throw new Error("Project resolves outside the workspace root");
    }
    return { name: normalized, path: canonical };
  }

  async createProject(name: string): Promise<WorkspaceProject> {
    this.#ensureInitialized();
    const normalized = normalizeProjectName(name);
    const candidate = resolve(this.#canonicalRoot!, normalized);
    if (dirname(candidate) !== this.#canonicalRoot) {
      throw new Error("Project must be a direct child of the workspace root");
    }
    await mkdir(candidate, { recursive: false, mode: 0o755 });
    return await this.resolveExistingProject(normalized);
  }

  async projectNameForPath(path: string): Promise<string | undefined> {
    this.#ensureInitialized();
    const absolute = resolve(path);
    const stat = await lstat(absolute).catch(() => undefined);
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) return undefined;
    const canonical = await realpath(absolute);
    if (dirname(canonical) !== this.#canonicalRoot) return undefined;
    const name = canonical.slice(this.#canonicalRoot!.length + 1);
    if (!name || name.includes(sep)) return undefined;
    return normalizeProjectName(name);
  }

  contains(path: string): boolean {
    this.#ensureInitialized();
    const rel = relative(this.#canonicalRoot!, resolve(path));
    return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
  }

  #ensureInitialized(): void {
    if (!this.#canonicalRoot) {
      throw new Error("ProjectWorkspaceRoot.initialize() must complete first");
    }
  }
}

export function normalizeProjectName(value: string): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  if (!normalized || Array.from(normalized).length > 96) {
    throw new Error("Project name must contain 1-96 visible characters");
  }
  if (normalized === "." || normalized === ".." || normalized.startsWith(".")) {
    throw new Error("Hidden or relative project names are not allowed");
  }
  if (normalized.includes("/") || normalized.includes("\\")) {
    throw new Error("Project name must not contain path separators");
  }
  return normalized;
}
