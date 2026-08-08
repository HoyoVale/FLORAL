import {
  lstat,
  mkdir,
  open,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { WorkspaceProject } from "./project-workspace.js";

const CONTEXT_DIRECTORY = ".floral";
const CONTEXT_FILE = "CONTEXT.md";
const DECISIONS_FILE = "DECISIONS.md";
const KNOWN_ISSUES_FILE = "KNOWN_ISSUES.md";
const AGENTS_FILE = "AGENTS.md";
const AGENTS_OVERRIDE_FILE = "AGENTS.override.md";

const FLORAL_CONTEXT_BEGIN = "<!-- FLORAL:PROJECT-CONTEXT:BEGIN -->";
const FLORAL_CONTEXT_END = "<!-- FLORAL:PROJECT-CONTEXT:END -->";
const MAX_STANDARD_INSTRUCTION_BYTES = 32 * 1024;

export interface ProjectContextStatus {
  initialized: boolean;
  activeInstructionFile: "AGENTS.md" | "AGENTS.override.md" | undefined;
  instructionLinked: boolean;
  contextPresent: boolean;
  decisionsPresent: boolean;
  knownIssuesPresent: boolean;
}

export interface ProjectContextBootstrapResult {
  changed: boolean;
  createdFiles: string[];
  instructionAction: "created" | "linked" | "unchanged";
  status: ProjectContextStatus;
}

export async function inspectProjectContext(
  project: WorkspaceProject,
): Promise<ProjectContextStatus> {
  const canonicalProject = await canonicalProjectDirectory(project);
  const contextDirectory = join(canonicalProject, CONTEXT_DIRECTORY);
  const contextDirectoryReady = await regularDirectoryExists(contextDirectory);

  const overridePath = join(canonicalProject, AGENTS_OVERRIDE_FILE);
  const agentsPath = join(canonicalProject, AGENTS_FILE);
  const overrideStat = await lstat(overridePath).catch(() => undefined);
  const agentsStat = await lstat(agentsPath).catch(() => undefined);
  validateInstructionEntry(overridePath, overrideStat);
  validateInstructionEntry(agentsPath, agentsStat);
  const activeInstructionFile = overrideStat
    ? AGENTS_OVERRIDE_FILE
    : agentsStat
      ? AGENTS_FILE
      : undefined;

  let instructionLinked = false;
  if (activeInstructionFile) {
    const instructionPath = join(canonicalProject, activeInstructionFile);
    const content = await readValidatedRegularFile(
      instructionPath,
      canonicalProject,
    );
    instructionLinked = hasManagedInstructionBlock(content);
  }

  const contextPresent = contextDirectoryReady
    && await regularFileExists(join(contextDirectory, CONTEXT_FILE));
  const decisionsPresent = contextDirectoryReady
    && await regularFileExists(join(contextDirectory, DECISIONS_FILE));
  const knownIssuesPresent = contextDirectoryReady
    && await regularFileExists(join(contextDirectory, KNOWN_ISSUES_FILE));

  return {
    initialized: Boolean(
      activeInstructionFile
      && instructionLinked
      && contextPresent
      && decisionsPresent
      && knownIssuesPresent
    ),
    activeInstructionFile,
    instructionLinked,
    contextPresent,
    decisionsPresent,
    knownIssuesPresent,
  };
}

export async function bootstrapProjectContext(
  project: WorkspaceProject,
): Promise<ProjectContextBootstrapResult> {
  const canonicalProject = await canonicalProjectDirectory(project);
  const contextDirectory = join(canonicalProject, CONTEXT_DIRECTORY);
  const overridePath = join(canonicalProject, AGENTS_OVERRIDE_FILE);
  const agentsPath = join(canonicalProject, AGENTS_FILE);

  const contextDirectoryStat = await lstat(contextDirectory).catch(() => undefined);
  if (contextDirectoryStat) {
    if (contextDirectoryStat.isSymbolicLink() || !contextDirectoryStat.isDirectory()) {
      throw new Error(".floral must be a real project-local directory");
    }
    const canonicalContext = await realpath(contextDirectory);
    if (dirname(canonicalContext) !== canonicalProject) {
      throw new Error(".floral resolves outside the project");
    }
  }

  const overrideStat = await lstat(overridePath).catch(() => undefined);
  const agentsStat = await lstat(agentsPath).catch(() => undefined);
  validateInstructionEntry(overridePath, overrideStat);
  validateInstructionEntry(agentsPath, agentsStat);

  const activeInstructionPath = overrideStat
    ? overridePath
    : agentsStat
      ? agentsPath
      : agentsPath;
  const activeInstructionFile = overrideStat
    ? AGENTS_OVERRIDE_FILE
    : AGENTS_FILE;

  let existingInstruction = "";
  if (overrideStat || agentsStat) {
    existingInstruction = await readValidatedRegularFile(
      activeInstructionPath,
      canonicalProject,
    );
    validateManagedMarkers(existingInstruction);
    if (!hasManagedInstructionBlock(existingInstruction)) {
      const nextBytes = Buffer.byteLength(
        appendManagedInstruction(existingInstruction, project.name),
        "utf8",
      );
      if (nextBytes > MAX_STANDARD_INSTRUCTION_BYTES) {
        throw new Error(
          `${activeInstructionFile} would exceed the default Codex 32 KiB project instruction limit`,
        );
      }
    }
  }

  const contextFiles = [
    [CONTEXT_FILE, renderContextTemplate(project.name)],
    [DECISIONS_FILE, renderDecisionsTemplate()],
    [KNOWN_ISSUES_FILE, renderKnownIssuesTemplate()],
  ] as const;

  for (const [fileName] of contextFiles) {
    const filePath = join(contextDirectory, fileName);
    const stat = await lstat(filePath).catch(() => undefined);
    if (!stat) continue;
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
      throw new Error(`${CONTEXT_DIRECTORY}/${fileName} must be a single-link regular file`);
    }
    const canonicalFile = await realpath(filePath);
    const canonicalContext = contextDirectoryStat
      ? await realpath(contextDirectory)
      : contextDirectory;
    if (dirname(canonicalFile) !== canonicalContext) {
      throw new Error(`${CONTEXT_DIRECTORY}/${fileName} resolves outside .floral`);
    }
  }

  const createdFiles: string[] = [];
  let instructionAction: ProjectContextBootstrapResult["instructionAction"] = "unchanged";

  if (!contextDirectoryStat) {
    await mkdir(contextDirectory, { recursive: false, mode: 0o755 });
  }

  for (const [fileName, content] of contextFiles) {
    const filePath = join(contextDirectory, fileName);
    const stat = await lstat(filePath).catch(() => undefined);
    if (stat) continue;
    await writeFile(filePath, content, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o644,
    });
    createdFiles.push(`${CONTEXT_DIRECTORY}/${fileName}`);
  }

  if (!overrideStat && !agentsStat) {
    await writeFile(
      agentsPath,
      renderCreatedAgentsFile(project.name),
      {
        encoding: "utf8",
        flag: "wx",
        mode: 0o644,
      },
    );
    createdFiles.push(AGENTS_FILE);
    instructionAction = "created";
  } else if (!hasManagedInstructionBlock(existingInstruction)) {
    const file = await open(activeInstructionPath, "r+");
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1) {
        throw new Error(`${activeInstructionFile} changed during context initialization`);
      }
      const current = await file.readFile({ encoding: "utf8" });
      validateManagedMarkers(current);
      if (!hasManagedInstructionBlock(current)) {
        const next = appendManagedInstruction(current, project.name);
        if (Buffer.byteLength(next, "utf8") > MAX_STANDARD_INSTRUCTION_BYTES) {
          throw new Error(
            `${activeInstructionFile} would exceed the default Codex 32 KiB project instruction limit`,
          );
        }
        await file.truncate(0);
        await file.write(next, 0, "utf8");
        instructionAction = "linked";
      }
    } finally {
      await file.close();
    }
  }

  const status = await inspectProjectContext(project);
  if (!status.initialized) {
    throw new Error("Project context initialization did not reach a complete state");
  }

  return {
    changed: createdFiles.length > 0 || instructionAction === "linked",
    createdFiles,
    instructionAction,
    status,
  };
}

function validateInstructionEntry(
  path: string,
  stat: Awaited<ReturnType<typeof lstat>> | undefined,
): void {
  if (!stat) return;
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw new Error(`${path} must be a single-link regular non-symlink file`);
  }
}

async function canonicalProjectDirectory(
  project: WorkspaceProject,
): Promise<string> {
  const absolute = resolve(project.path);
  const stat = await lstat(absolute).catch(() => undefined);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Project context requires a real project directory");
  }
  const canonical = await realpath(absolute);
  if (canonical !== absolute) {
    throw new Error("Project path must already be canonical");
  }
  return canonical;
}

async function regularDirectoryExists(path: string): Promise<boolean> {
  const stat = await lstat(path).catch(() => undefined);
  return Boolean(stat && !stat.isSymbolicLink() && stat.isDirectory());
}

async function regularFileExists(path: string): Promise<boolean> {
  const stat = await lstat(path).catch(() => undefined);
  return Boolean(
    stat
    && !stat.isSymbolicLink()
    && stat.isFile()
    && stat.nlink === 1
  );
}

async function readValidatedRegularFile(
  path: string,
  expectedParent: string,
): Promise<string> {
  const stat = await lstat(path).catch(() => undefined);
  if (!stat || stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw new Error(`${path} must be a single-link regular non-symlink file`);
  }
  const canonical = await realpath(path);
  if (dirname(canonical) !== expectedParent) {
    throw new Error(`${path} resolves outside its expected project directory`);
  }
  const file = await open(path, "r");
  try {
    return await file.readFile({ encoding: "utf8" });
  } finally {
    await file.close();
  }
}

function validateManagedMarkers(content: string): void {
  const beginCount = countOccurrences(content, FLORAL_CONTEXT_BEGIN);
  const endCount = countOccurrences(content, FLORAL_CONTEXT_END);
  if (beginCount !== endCount || beginCount > 1) {
    throw new Error("FLORAL project-context markers are malformed");
  }
}

function hasManagedInstructionBlock(content: string): boolean {
  return content.includes(FLORAL_CONTEXT_BEGIN)
    && content.includes(FLORAL_CONTEXT_END);
}

function countOccurrences(content: string, token: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = content.indexOf(token, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + token.length;
  }
}

function appendManagedInstruction(
  existing: string,
  projectName: string,
): string {
  const normalized = existing.replace(/\s+$/u, "");
  const separator = normalized ? "\n\n" : "";
  return `${normalized}${separator}${renderManagedInstructionBlock(projectName)}\n`;
}

function renderCreatedAgentsFile(projectName: string): string {
  return [
    "# Project instructions",
    "",
    `FLORAL project: ${markdownInline(projectName)}`,
    "",
    renderManagedInstructionBlock(projectName),
    "",
  ].join("\n");
}

function renderManagedInstructionBlock(projectName: string): string {
  return [
    FLORAL_CONTEXT_BEGIN,
    "## FLORAL shared project context",
    "",
    `Project name: ${markdownInline(projectName)}`,
    "",
    "Before substantial project work, consult these project-local shared context files when present and relevant:",
    "",
    "- `.floral/CONTEXT.md` — stable project facts and current shared state.",
    "- `.floral/DECISIONS.md` — durable architecture/product decisions.",
    "- `.floral/KNOWN_ISSUES.md` — active known issues and constraints.",
    "",
    "Treat these files as shared across Codex chats in this project.",
    "Phase 7.3A does not maintain them automatically; do not modify them unless the user explicitly asks to update project context.",
    "These files are project guidance, not an authorization boundary. FLORAL/Codex runtime permissions remain authoritative.",
    FLORAL_CONTEXT_END,
  ].join("\n");
}

function renderContextTemplate(projectName: string): string {
  return [
    "# Project Context",
    "",
    "> Shared project-level facts for Codex chats in this directory.",
    "> Phase 7.3A does not update this file automatically.",
    "",
    `- Project: ${markdownInline(projectName)}`,
    "- Workspace managed by FLORAL: yes",
    "",
    "## Stable context",
    "",
    "No shared context recorded yet.",
    "",
  ].join("\n");
}

function renderDecisionsTemplate(): string {
  return [
    "# Project Decisions",
    "",
    "> Durable decisions shared across Codex chats.",
    "> Add concise decisions only when the user explicitly asks to update project context.",
    "",
    "No durable decisions recorded yet.",
    "",
  ].join("\n");
}

function renderKnownIssuesTemplate(): string {
  return [
    "# Known Issues",
    "",
    "> Active known issues and constraints shared across Codex chats.",
    "> Add concise items only when the user explicitly asks to update project context.",
    "",
    "No known issues recorded yet.",
    "",
  ].join("\n");
}

function markdownInline(value: string): string {
  return value.replace(/([\\`*_{}\[\]()#+.!|-])/gu, "\\$1");
}
