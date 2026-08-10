import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { WorkspaceProject } from "./project-workspace.js";
import {
  listProjectContextLedgerEntries,
  recordProjectContextLedgerEntry,
  updateProjectContextLedgerEntry,
  type ProjectContextLedgerSource,
} from "./project-context-ledger.js";

const CONTEXT_DIRECTORY = ".floral";
const CONTEXT_FILE = "CONTEXT.md";
const DECISIONS_FILE = "DECISIONS.md";
const KNOWN_ISSUES_FILE = "KNOWN_ISSUES.md";
const AGENTS_FILE = "AGENTS.md";
const AGENTS_OVERRIDE_FILE = "AGENTS.override.md";

const FLORAL_CONTEXT_BEGIN = "<!-- FLORAL:PROJECT-CONTEXT:BEGIN -->";
const FLORAL_CONTEXT_END = "<!-- FLORAL:PROJECT-CONTEXT:END -->";
const MAX_STANDARD_INSTRUCTION_BYTES = 32 * 1024;
const MAX_MEMORY_ENTRY_CHARACTERS = 1_200;
const MAX_MEMORY_FILE_BYTES = 64 * 1024;
const MAX_MEMORY_ENTRIES_PER_FILE = 256;
const FLORAL_MEMORY_BEGIN = "<!-- FLORAL:PROJECT-MEMORY:BEGIN -->";
const FLORAL_MEMORY_END = "<!-- FLORAL:PROJECT-MEMORY:END -->";

export type ProjectMemoryKind = "context" | "decision" | "issue";

export interface ProjectMemoryStatus {
  contextEntries: number;
  decisionEntries: number;
  issueEntries: number;
  contextBytes: number;
  decisionBytes: number;
  issueBytes: number;
}

export interface ProjectMemoryRecordResult {
  changed: boolean;
  duplicate: boolean;
  kind: ProjectMemoryKind;
  fingerprint: string;
  entryCount: number;
  fileBytes: number;
  ledgerEntryId: string;
}

export interface ProjectMemoryProvenance {
  source: ProjectContextLedgerSource;
  evidenceRefs?: readonly string[] | undefined;
}

export interface ProjectMemoryVerification {
  present: boolean;
  target: ProjectMemoryKind | "agents";
  ledgerEntryId: string;
}

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

export async function refreshProjectManagedInstructions(
  project: WorkspaceProject,
  now: Date = new Date(),
): Promise<{ changed: boolean; instructionFile: string; ledgerEntryId: string }> {
  const status = await inspectProjectContext(project);
  if (!status.initialized || !status.activeInstructionFile) {
    throw new Error("Project shared context is not initialized");
  }
  const canonicalProject = await canonicalProjectDirectory(project);
  const instructionPath = join(canonicalProject, status.activeInstructionFile);
  const current = await readValidatedRegularFile(instructionPath, canonicalProject);
  validateManagedMarkers(current);
  const expectedBlock = renderManagedInstructionBlock(project.name);
  const existingBlock = extractManagedInstructionBlock(current);
  if (!existingBlock) throw new Error("FLORAL managed instruction block is missing");
  const next = current.replace(existingBlock, expectedBlock);
  if (Buffer.byteLength(next, "utf8") > MAX_STANDARD_INSTRUCTION_BYTES) {
    throw new Error(`${status.activeInstructionFile} exceeds the default Codex 32 KiB project instruction limit`);
  }
  if (next !== current) {
    const file = await open(instructionPath, "r+");
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1) {
        throw new Error(`${status.activeInstructionFile} changed during managed refresh`);
      }
      const latest = await file.readFile({ encoding: "utf8" });
      if (latest !== current) throw new Error("Project instructions changed concurrently; retry");
      await file.truncate(0);
      await file.write(next, 0, "utf8");
    } finally {
      await file.close();
    }
  }
  const contentHash = createHash("sha256").update(expectedBlock, "utf8").digest("hex");
  const ledger = await recordProjectContextLedgerEntry(project, {
    target: "agents",
    contentHash,
    source: "agent-proposal",
    evidenceRefs: ["floral:managed-instruction-contract"],
    now,
  });
  return {
    changed: next !== current,
    instructionFile: status.activeInstructionFile,
    ledgerEntryId: ledger.id,
  };
}

export async function inspectProjectMemory(
  project: WorkspaceProject,
): Promise<ProjectMemoryStatus> {
  const status = await inspectProjectContext(project);
  if (!status.initialized) {
    throw new Error("Project shared context is not initialized");
  }
  const canonicalProject = await canonicalProjectDirectory(project);
  const contextDirectory = await canonicalContextDirectory(canonicalProject);
  const context = await readMemoryFile(contextDirectory, CONTEXT_FILE);
  const decisions = await readMemoryFile(contextDirectory, DECISIONS_FILE);
  const issues = await readMemoryFile(contextDirectory, KNOWN_ISSUES_FILE);
  return {
    contextEntries: countManagedMemoryEntries(context),
    decisionEntries: countManagedMemoryEntries(decisions),
    issueEntries: countManagedMemoryEntries(issues),
    contextBytes: Buffer.byteLength(context, "utf8"),
    decisionBytes: Buffer.byteLength(decisions, "utf8"),
    issueBytes: Buffer.byteLength(issues, "utf8"),
  };
}

export async function recordProjectMemory(
  project: WorkspaceProject,
  kind: ProjectMemoryKind,
  text: string,
  now: Date = new Date(),
  provenance: ProjectMemoryProvenance = { source: "owner-command" },
): Promise<ProjectMemoryRecordResult> {
  const normalized = normalizeMemoryText(text);
  const status = await inspectProjectContext(project);
  if (!status.initialized) {
    throw new Error("Project shared context is not initialized");
  }

  const canonicalProject = await canonicalProjectDirectory(project);
  const contextDirectory = await canonicalContextDirectory(canonicalProject);
  const fileName = memoryFileForKind(kind);
  const filePath = join(contextDirectory, fileName);
  const current = await readMemoryFile(contextDirectory, fileName);
  validateMemoryMarkers(current);

  const fingerprint = createHash("sha256")
    .update(`${kind}\u0000${normalized}`, "utf8")
    .digest("hex");
  const marker = `<!-- FLORAL:MEM:${fingerprint.slice(0, 16)} -->`;
  const currentCount = countManagedMemoryEntries(current);
  if (current.includes(marker)) {
    const ledger = await recordProjectContextLedgerEntry(project, {
      target: kind,
      contentHash: fingerprint,
      source: provenance.source,
      evidenceRefs: provenance.evidenceRefs,
      now,
    });
    return {
      changed: false,
      duplicate: true,
      kind,
      fingerprint,
      entryCount: currentCount,
      fileBytes: Buffer.byteLength(current, "utf8"),
      ledgerEntryId: ledger.id,
    };
  }
  if (currentCount >= MAX_MEMORY_ENTRIES_PER_FILE) {
    throw new Error("Project memory entry limit reached");
  }

  const timestamp = now.toISOString();
  const entry = `- [${timestamp}] ${escapeMemoryMarkdown(normalized)} ${marker}`;
  const next = appendManagedMemoryEntry(current, entry, kind);
  const nextBytes = Buffer.byteLength(next, "utf8");
  if (nextBytes > MAX_MEMORY_FILE_BYTES) {
    throw new Error("Project memory file size limit reached");
  }

  const file = await open(filePath, "r+");
  try {
    const fileStat = await file.stat();
    if (!fileStat.isFile() || fileStat.nlink !== 1) {
      throw new Error(`${CONTEXT_DIRECTORY}/${fileName} changed during memory write`);
    }
    const latest = await file.readFile({ encoding: "utf8" });
    validateMemoryMarkers(latest);
    if (latest !== current) {
      throw new Error("Project memory changed concurrently; retry the command");
    }
    await file.truncate(0);
    await file.write(next, 0, "utf8");
  } finally {
    await file.close();
  }

  const ledger = await recordProjectContextLedgerEntry(project, {
    target: kind,
    contentHash: fingerprint,
    source: provenance.source,
    evidenceRefs: provenance.evidenceRefs,
    now,
  });

  return {
    changed: true,
    duplicate: false,
    kind,
    fingerprint,
    entryCount: currentCount + 1,
    fileBytes: nextBytes,
    ledgerEntryId: ledger.id,
  };
}

export async function readProjectMemoryDocument(
  project: WorkspaceProject,
  kind: ProjectMemoryKind,
): Promise<string> {
  const status = await inspectProjectContext(project);
  if (!status.initialized) {
    throw new Error("Project shared context is not initialized");
  }
  const canonicalProject = await canonicalProjectDirectory(project);
  const contextDirectory = await canonicalContextDirectory(canonicalProject);
  return await readMemoryFile(contextDirectory, memoryFileForKind(kind));
}

export async function verifyProjectMemoryLedgerEntry(
  project: WorkspaceProject,
  ledgerEntryId: string,
): Promise<ProjectMemoryVerification | undefined> {
  const entries = await listProjectContextLedgerEntries(project);
  const entry = entries.find((candidate) => candidate.id === ledgerEntryId);
  if (!entry) return undefined;
  if (entry.target === "agents") {
    const status = await inspectProjectContext(project);
    const canonicalProject = await canonicalProjectDirectory(project);
    const document = status.activeInstructionFile
      ? await readValidatedRegularFile(
          join(canonicalProject, status.activeInstructionFile),
          canonicalProject,
        )
      : "";
    const block = extractManagedInstructionBlock(document);
    const present = Boolean(block)
      && createHash("sha256").update(block!, "utf8").digest("hex") === entry.contentHash;
    await updateProjectContextLedgerEntry(project, entry.id, {
      status: present ? "active" : "stale",
    });
    return { present, target: "agents", ledgerEntryId: entry.id };
  }
  const kind = entry.target;
  const document = await readProjectMemoryDocument(project, kind);
  const marker = `<!-- FLORAL:MEM:${entry.contentHash.slice(0, 16)} -->`;
  const present = document.includes(marker);
  await updateProjectContextLedgerEntry(project, entry.id, {
    status: present ? "active" : "stale",
  });
  return {
    present,
    target: kind,
    ledgerEntryId: entry.id,
  };
}

export async function reconcileProjectMemoryLedger(
  project: WorkspaceProject,
): Promise<{ checked: number; active: number; stale: number; skipped: number }> {
  const entries = await listProjectContextLedgerEntries(project);
  let checked = 0;
  let active = 0;
  let stale = 0;
  let skipped = 0;
  for (const entry of entries) {
    if (entry.target === "agents") {
      skipped += 1;
      continue;
    }
    const document = await readProjectMemoryDocument(project, entry.target);
    const marker = `<!-- FLORAL:MEM:${entry.contentHash.slice(0, 16)} -->`;
    const present = document.includes(marker);
    await updateProjectContextLedgerEntry(project, entry.id, {
      status: present ? "active" : "stale",
    });
    checked += 1;
    if (present) active += 1;
    else stale += 1;
  }
  return { checked, active, stale, skipped };
}

function memoryFileForKind(kind: ProjectMemoryKind): string {
  if (kind === "context") return CONTEXT_FILE;
  if (kind === "decision") return DECISIONS_FILE;
  return KNOWN_ISSUES_FILE;
}

async function canonicalContextDirectory(canonicalProject: string): Promise<string> {
  const contextDirectory = join(canonicalProject, CONTEXT_DIRECTORY);
  const stat = await lstat(contextDirectory).catch(() => undefined);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(".floral must be a real project-local directory");
  }
  const canonical = await realpath(contextDirectory);
  if (dirname(canonical) !== canonicalProject) {
    throw new Error(".floral resolves outside the project");
  }
  return canonical;
}

async function readMemoryFile(
  contextDirectory: string,
  fileName: string,
): Promise<string> {
  return await readValidatedRegularFile(
    join(contextDirectory, fileName),
    contextDirectory,
  );
}

function normalizeMemoryText(value: string): string {
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)) {
    throw new Error("Project memory contains unsupported control characters");
  }
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized) throw new Error("Project memory entry must not be empty");
  if (normalized.length > MAX_MEMORY_ENTRY_CHARACTERS) {
    throw new Error(`Project memory entry exceeds ${MAX_MEMORY_ENTRY_CHARACTERS} characters`);
  }
  return normalized;
}

function validateMemoryMarkers(content: string): void {
  const beginCount = countOccurrences(content, FLORAL_MEMORY_BEGIN);
  const endCount = countOccurrences(content, FLORAL_MEMORY_END);
  if (beginCount !== endCount || beginCount > 1) {
    throw new Error("FLORAL project-memory markers are malformed");
  }
}

function countManagedMemoryEntries(content: string): number {
  validateMemoryMarkers(content);
  return [...content.matchAll(/<!-- FLORAL:MEM:[a-f0-9]{16} -->/gu)].length;
}

function appendManagedMemoryEntry(
  existing: string,
  entry: string,
  kind: ProjectMemoryKind,
): string {
  const placeholder = placeholderForKind(kind);
  const normalized = existing
    .replace(placeholder, "")
    .replace(/\s+$/u, "");
  if (!normalized.includes(FLORAL_MEMORY_BEGIN)) {
    return [
      normalized,
      "",
      FLORAL_MEMORY_BEGIN,
      "## FLORAL recorded entries",
      "",
      entry,
      FLORAL_MEMORY_END,
      "",
    ].join("\n");
  }
  const endIndex = normalized.indexOf(FLORAL_MEMORY_END);
  if (endIndex < 0) throw new Error("FLORAL project-memory markers are malformed");
  const before = normalized.slice(0, endIndex).replace(/\s+$/u, "");
  const after = normalized.slice(endIndex + FLORAL_MEMORY_END.length).replace(/^\s+/u, "");
  return [
    before,
    entry,
    FLORAL_MEMORY_END,
    ...(after ? [after] : []),
    "",
  ].join("\n");
}

function placeholderForKind(kind: ProjectMemoryKind): string {
  if (kind === "context") return "No shared context recorded yet.";
  if (kind === "decision") return "No durable decisions recorded yet.";
  return "No known issues recorded yet.";
}

function escapeMemoryMarkdown(value: string): string {
  return value
    .replace(/\\/gu, "\\\\")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
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

function extractManagedInstructionBlock(content: string): string | undefined {
  validateManagedMarkers(content);
  const begin = content.indexOf(FLORAL_CONTEXT_BEGIN);
  const end = content.indexOf(FLORAL_CONTEXT_END);
  if (begin < 0 || end < begin) return undefined;
  return content.slice(begin, end + FLORAL_CONTEXT_END.length);
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
    "Use floral_context for governed reads and updates. An Agent must create a proposal first; FLORAL applies it only after host authorization and records provenance. Do not edit these files or this managed instruction block directly through shell/file tools.",
    "These files are project guidance, not an authorization boundary. FLORAL/Codex runtime permissions remain authoritative.",
    FLORAL_CONTEXT_END,
  ].join("\n");
}

function renderContextTemplate(projectName: string): string {
  return [
    "# Project Context",
    "",
    "> Shared project-level facts for Codex chats in this directory.",
    "> Governed updates use FLORAL proposal, authorization, and provenance receipts.",
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
    "> Governed updates use FLORAL proposal, authorization, and provenance receipts.",
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
    "> Governed updates use FLORAL proposal, authorization, and provenance receipts.",
    "",
    "No known issues recorded yet.",
    "",
  ].join("\n");
}

function markdownInline(value: string): string {
  return value.replace(/([\\`*_{}\[\]()#+.!|-])/gu, "\\$1");
}
