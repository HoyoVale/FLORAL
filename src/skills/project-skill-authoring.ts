import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { AgentSkillSummary } from "../core/contracts.js";
import type { Capability } from "../core/types.js";

const MAX_SKILL_NAME_LENGTH = 64;
const MAX_FILES = 64;
const MAX_FILE_BYTES = 128 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024;
const ALLOWED_TOP_LEVEL = new Set([
  "SKILL.md",
  "proposal.json",
  "agents",
  "assets",
  "references",
  "scripts",
]);
const KNOWN_CAPABILITIES = new Set<Capability>([
  "machine.status.read",
  "screen.capture",
  "files.read",
  "files.write",
  "files.delete",
  "shell.execute",
  "software.install",
  "extension.install",
  "extension.update",
  "extension.remove",
  "extension.enable",
  "extension.disable",
  "skill.publish",
  "github.repository.read",
  "github.issue.write",
  "github.pull-request.write",
  "github.actions.run",
  "browser.inspect",
  "application.open",
  "application.control",
  "browser.submit",
  "message.send",
  "web.search",
  "codex.permission.grant",
  "system.restart",
  "system.admin",
]);

export interface ProjectSkillTestCase {
  prompt: string;
  expectedBehavior: string;
}

export interface ProjectSkillProposal {
  schemaVersion: 1;
  name: string;
  description: string;
  permissions: Capability[];
  expectedTools: string[];
  tests: {
    shouldTrigger: ProjectSkillTestCase[];
    shouldNotTrigger: ProjectSkillTestCase[];
  };
}

export interface ProjectSkillDraftReport {
  status: "validated" | "invalid";
  name: string;
  action: "create" | "update";
  draftPath: string;
  targetPath: string;
  digest?: string | undefined;
  description?: string | undefined;
  permissions: Capability[];
  expectedTools: string[];
  fileCount: number;
  totalBytes: number;
  checks: string[];
  errors: string[];
}

export interface ProjectSkillPublication {
  publicationId: string;
  name: string;
  action: "create" | "update";
  digest: string;
  targetPath: string;
  backupPath?: string | undefined;
  publishedAt: string;
}

interface ProjectSkillReceipt extends ProjectSkillPublication {
  schemaVersion: 1;
  status: "published" | "verified" | "rolled-back";
  projectHash: string;
  permissions: Capability[];
  verification?: string | undefined;
}

export class ProjectSkillAuthoringManager {
  readonly #cwd: string;
  readonly #projectSkillsRoot: string;
  readonly #draftsRoot: string;
  readonly #receiptRoot: string;

  constructor(options: { cwd: string; runtimeDataRoot: string }) {
    this.#cwd = resolve(options.cwd);
    this.#projectSkillsRoot = join(this.#cwd, ".agents", "skills");
    this.#draftsRoot = join(this.#cwd, ".agents", "skill-drafts");
    const projectHash = sha256(this.#cwd).slice(0, 24);
    this.#receiptRoot = join(resolve(options.runtimeDataRoot), projectHash, "receipts");
  }

  async validateDraft(
    rawName: string,
    discoveredSkills: AgentSkillSummary[],
  ): Promise<ProjectSkillDraftReport> {
    const name = validateSkillName(rawName);
    const draftPath = join(this.#draftsRoot, name);
    const targetPath = join(this.#projectSkillsRoot, name);
    const errors: string[] = [];
    const checks: string[] = [];
    let permissions: Capability[] = [];
    let expectedTools: string[] = [];
    let description: string | undefined;
    let fileCount = 0;
    let totalBytes = 0;
    let digest: string | undefined;
    let action: "create" | "update" = "create";

    const targetStat = await lstat(targetPath).catch((error: unknown) => {
      if (isMissing(error)) return undefined;
      throw error;
    });
    if (targetStat) {
      action = "update";
      if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
        errors.push("target-not-regular-directory");
      }
    }

    const tree = await readDraftTree(draftPath).catch((error: unknown) => {
      errors.push(error instanceof Error ? error.message : "draft-read-failed");
      return undefined;
    });
    if (tree) {
      fileCount = tree.files.length;
      totalBytes = tree.totalBytes;
      checks.push("bounded-tree", "no-symlinks");
      const topLevels = new Set(tree.files.map((entry) => entry.relativePath.split("/")[0]));
      for (const topLevel of topLevels) {
        if (topLevel && !ALLOWED_TOP_LEVEL.has(topLevel)) {
          errors.push(`unsupported-top-level:${topLevel}`);
        }
      }
      if (!tree.files.some((entry) => entry.relativePath === "SKILL.md")) {
        errors.push("skill-md-not-found");
      }
      if (!tree.files.some((entry) => entry.relativePath === "proposal.json")) {
        errors.push("proposal-json-not-found");
      }

      const proposalEntry = tree.files.find((entry) => entry.relativePath === "proposal.json");
      const skillEntry = tree.files.find((entry) => entry.relativePath === "SKILL.md");
      const proposal = proposalEntry
        ? parseProposal(proposalEntry.content, name, errors)
        : undefined;
      const frontmatter = skillEntry
        ? parseSkillFrontmatter(skillEntry.content.toString("utf8"), errors)
        : undefined;
      if (proposal) {
        permissions = proposal.permissions;
        expectedTools = proposal.expectedTools;
        description = proposal.description;
        checks.push("proposal-schema", "trigger-tests", "declared-permissions");
      }
      if (frontmatter) {
        description ??= frontmatter.description;
        if (frontmatter.name !== name) errors.push("frontmatter-name-mismatch");
        if (proposal && frontmatter.description !== proposal.description) {
          errors.push("frontmatter-description-mismatch");
        }
        checks.push("codex-frontmatter");
      }
      enforcePolicy(tree.files, permissions, errors);
      if (errors.length === 0) checks.push("policy-boundary");
      digest = computeTreeDigest(tree.files);
    }

    const collisions = discoveredSkills.filter((skill) => skill.name === name);
    for (const collision of collisions) {
      if (resolve(collision.path) !== resolve(join(targetPath, "SKILL.md"))) {
        errors.push(`skill-name-collision:${collision.scope}`);
      }
    }
    if (!errors.some((error) => error.startsWith("skill-name-collision:"))) {
      checks.push("discovery-collision-check");
    }

    return {
      status: errors.length === 0 ? "validated" : "invalid",
      name,
      action,
      draftPath,
      targetPath,
      ...(digest ? { digest } : {}),
      ...(description ? { description } : {}),
      permissions,
      expectedTools,
      fileCount,
      totalBytes,
      checks: [...new Set(checks)],
      errors: [...new Set(errors)],
    };
  }

  async publishValidatedDraft(
    report: ProjectSkillDraftReport,
  ): Promise<ProjectSkillPublication> {
    if (report.status !== "validated" || !report.digest) {
      throw new Error("Skill draft must be validated before publication");
    }
    const tree = await readDraftTree(report.draftPath);
    if (computeTreeDigest(tree.files) !== report.digest) {
      throw new Error("Skill draft changed after validation");
    }

    await mkdir(this.#projectSkillsRoot, { recursive: true, mode: 0o700 });
    const publicationId = randomUUID();
    const stagingPath = join(
      dirname(this.#projectSkillsRoot),
      `.skill-staging-${report.name}-${publicationId}`,
    );
    const backupPath = `${report.targetPath}.backup-${publicationId}`;
    let existingMoved = false;
    let published = false;

    try {
      await mkdir(stagingPath, { recursive: true, mode: 0o700 });
      for (const file of tree.files) {
        if (file.relativePath === "proposal.json") continue;
        const output = safeJoin(stagingPath, file.relativePath);
        await mkdir(dirname(output), { recursive: true, mode: 0o700 });
        await writeFile(output, file.content, { mode: file.mode & 0o755 });
      }
      const existing = await lstat(report.targetPath).catch((error: unknown) => {
        if (isMissing(error)) return undefined;
        throw error;
      });
      if (existing) {
        if (!existing.isDirectory() || existing.isSymbolicLink()) {
          throw new Error("Project Skill target is not a regular directory");
        }
        await rename(report.targetPath, backupPath);
        existingMoved = true;
      }
      await rename(stagingPath, report.targetPath);
      published = true;
      const publication: ProjectSkillPublication = {
        publicationId,
        name: report.name,
        action: report.action,
        digest: report.digest,
        targetPath: report.targetPath,
        ...(existingMoved ? { backupPath } : {}),
        publishedAt: new Date().toISOString(),
      };
      await this.#writeReceipt({
        schemaVersion: 1,
        ...publication,
        status: "published",
        projectHash: sha256(this.#cwd),
        permissions: report.permissions,
      });
      return publication;
    } catch (error) {
      if (published) await rm(report.targetPath, { recursive: true, force: true });
      if (existingMoved) await rename(backupPath, report.targetPath).catch(() => undefined);
      throw error;
    } finally {
      await rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async verifyPublication(
    publication: ProjectSkillPublication,
    permissions: Capability[],
    verification: string,
  ): Promise<void> {
    if (publication.backupPath) {
      await rm(publication.backupPath, { recursive: true, force: true });
    }
    await this.#writeReceipt({
      schemaVersion: 1,
      ...publication,
      status: "verified",
      projectHash: sha256(this.#cwd),
      permissions,
      verification: sanitizeReceiptText(verification),
    });
  }

  async rollbackPublication(
    publication: ProjectSkillPublication,
    permissions: Capability[],
    reason: string,
  ): Promise<void> {
    await rm(publication.targetPath, { recursive: true, force: true });
    if (publication.backupPath) {
      await rename(publication.backupPath, publication.targetPath);
    }
    await this.#writeReceipt({
      schemaVersion: 1,
      ...publication,
      status: "rolled-back",
      projectHash: sha256(this.#cwd),
      permissions,
      verification: sanitizeReceiptText(reason),
    });
  }

  async history(limit = 20): Promise<string> {
    const names = await readdir(this.#receiptRoot).catch((error: unknown) => {
      if (isMissing(error)) return [];
      throw error;
    });
    const records: ProjectSkillReceipt[] = [];
    for (const name of names.filter((entry) => entry.endsWith(".json")).sort().reverse().slice(0, limit)) {
      try {
        const value = JSON.parse(await readFile(join(this.#receiptRoot, name), "utf8")) as ProjectSkillReceipt;
        if (value.schemaVersion === 1 && value.projectHash === sha256(this.#cwd)) records.push(value);
      } catch {
        continue;
      }
    }
    if (records.length === 0) return "skill_publications.count=0";
    return [
      `skill_publications.count=${String(records.length)}`,
      ...records.map((record) => [
        `publication=${record.publicationId}`,
        `name=${record.name}`,
        `action=${record.action}`,
        `status=${record.status}`,
        `digest=${record.digest}`,
        `published_at=${record.publishedAt}`,
        `permissions=${record.permissions.join(",") || "none"}`,
        ...(record.verification ? [`verification=${record.verification}`] : []),
      ].join(" ")),
    ].join("\n");
  }

  async #writeReceipt(receipt: ProjectSkillReceipt): Promise<void> {
    await mkdir(this.#receiptRoot, { recursive: true, mode: 0o700 });
    await chmod(this.#receiptRoot, 0o700).catch(() => undefined);
    const path = join(
      this.#receiptRoot,
      `${receipt.publishedAt.replace(/[:.]/gu, "-")}-${receipt.publicationId}-${receipt.status}.json`,
    );
    const temporary = `${path}.tmp-${randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  }
}

interface DraftFile {
  relativePath: string;
  content: Buffer;
  mode: number;
}

async function readDraftTree(root: string): Promise<{ files: DraftFile[]; totalBytes: number }> {
  const rootStat = await lstat(root).catch((error: unknown) => {
    if (isMissing(error)) throw new Error("draft-not-found");
    throw error;
  });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("draft-not-regular-directory");
  const files: DraftFile[] = [];
  let totalBytes = 0;

  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error(`symlink-not-allowed:${relativePath(root, absolute)}`);
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!entry.isFile() || !stat.isFile()) throw new Error(`unsupported-entry:${relativePath(root, absolute)}`);
      if (stat.size > MAX_FILE_BYTES) throw new Error(`file-too-large:${relativePath(root, absolute)}`);
      const content = await readFile(absolute);
      totalBytes += content.byteLength;
      files.push({ relativePath: relativePath(root, absolute), content, mode: stat.mode });
      if (files.length > MAX_FILES) throw new Error("too-many-files");
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error("draft-too-large");
    }
  }

  await visit(root);
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { files, totalBytes };
}

function parseProposal(
  content: Buffer,
  expectedName: string,
  errors: string[],
): ProjectSkillProposal | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(content.toString("utf8"));
  } catch {
    errors.push("proposal-invalid-json");
    return undefined;
  }
  if (!isRecord(raw) || raw.schemaVersion !== 1) {
    errors.push("proposal-schema-version-invalid");
    return undefined;
  }
  const name = readText(raw.name, MAX_SKILL_NAME_LENGTH);
  const description = readText(raw.description, 1024);
  if (name !== expectedName) errors.push("proposal-name-mismatch");
  if (!description || description.includes("<") || description.includes(">")) {
    errors.push("proposal-description-invalid");
  }
  const permissionValues = Array.isArray(raw.permissions) ? raw.permissions : [];
  const permissions = permissionValues.flatMap((value) =>
    typeof value === "string" && KNOWN_CAPABILITIES.has(value as Capability)
      ? [value as Capability]
      : []
  );
  if (permissions.length !== permissionValues.length || new Set(permissions).size !== permissions.length) {
    errors.push("proposal-permissions-invalid");
  }
  const expectedTools = readStringArray(raw.expectedTools, 50, 160);
  if (!expectedTools || expectedTools.some((tool) => !/^[A-Za-z0-9_.:-]+(?:\/[A-Za-z0-9_.:-]+)?$/u.test(tool))) {
    errors.push("proposal-expected-tools-invalid");
  }
  const tests = isRecord(raw.tests) ? raw.tests : undefined;
  const shouldTrigger = parseTestCases(tests?.shouldTrigger, 2, errors, "should-trigger");
  const shouldNotTrigger = parseTestCases(tests?.shouldNotTrigger, 1, errors, "should-not-trigger");
  const prompts = [...shouldTrigger, ...shouldNotTrigger].map((entry) => entry.prompt.toLowerCase());
  if (new Set(prompts).size !== prompts.length) errors.push("proposal-test-prompts-overlap");
  if (!name || !description || !expectedTools) return undefined;
  return {
    schemaVersion: 1,
    name,
    description,
    permissions,
    expectedTools,
    tests: { shouldTrigger, shouldNotTrigger },
  };
}

function parseTestCases(
  raw: unknown,
  minimum: number,
  errors: string[],
  label: string,
): ProjectSkillTestCase[] {
  if (!Array.isArray(raw) || raw.length < minimum || raw.length > 20) {
    errors.push(`proposal-${label}-coverage-invalid`);
    return [];
  }
  const output: ProjectSkillTestCase[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) {
      errors.push(`proposal-${label}-case-invalid`);
      continue;
    }
    const prompt = readText(entry.prompt, 1000);
    const expectedBehavior = readText(entry.expectedBehavior, 1000);
    if (!prompt || !expectedBehavior) {
      errors.push(`proposal-${label}-case-invalid`);
      continue;
    }
    output.push({ prompt, expectedBehavior });
  }
  return output;
}

function parseSkillFrontmatter(
  text: string,
  errors: string[],
): { name: string; description: string } | undefined {
  const normalized = text.replace(/\r\n/gu, "\n");
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/u.exec(normalized);
  if (!match?.[1]) {
    errors.push("frontmatter-invalid");
    return undefined;
  }
  const fields = new Map<string, string>();
  for (const line of match[1].split("\n")) {
    if (!line.trim() || /^\s/u.test(line)) continue;
    const field = /^([A-Za-z0-9_-]+):\s*(.*)$/u.exec(line);
    if (!field?.[1]) {
      errors.push("frontmatter-restricted-yaml-invalid");
      continue;
    }
    fields.set(field[1], stripScalarQuotes(field[2] ?? ""));
  }
  const allowed = new Set(["name", "description", "license", "allowed-tools", "metadata"]);
  for (const key of fields.keys()) {
    if (!allowed.has(key)) errors.push(`frontmatter-key-unsupported:${key}`);
  }
  const name = fields.get("name")?.trim() ?? "";
  const description = fields.get("description")?.trim() ?? "";
  if (!isValidSkillName(name)) errors.push("frontmatter-name-invalid");
  if (!description || description.length > 1024 || /[<>]/u.test(description)) {
    errors.push("frontmatter-description-invalid");
  }
  const body = normalized.slice(match[0].length).trim();
  if (!body || body.split("\n").length > 500) errors.push("skill-body-invalid");
  return name && description ? { name, description } : undefined;
}

function enforcePolicy(files: DraftFile[], permissions: Capability[], errors: string[]): void {
  const text = files
    .filter((file) => /\.(?:md|json|ya?ml|txt|sh|zsh|bash|ts|js|mjs|py)$/iu.test(file.relativePath))
    .map((file) => file.content.toString("utf8"))
    .join("\n");
  const forbidden: Array<[RegExp, string]> = [
    [/data[\\/]external-(?:skills|extensions)[\\/](?:registry|packages)/iu, "direct-runtime-registry-access"],
    [/\bsudo\s+(?:-S\s+)?(?:sh|bash|zsh|rm|chmod|chown|cp|mv|security)\b/iu, "unrestricted-sudo"],
    [/\bsecurity\s+(?:find|add|delete)-(?:generic|internet)-password\b/iu, "keychain-access"],
    [/\b(?:curl|wget)\b[^\n|]{0,300}\|\s*(?:sh|bash|zsh)\b/iu, "remote-script-pipe"],
    [/(?:bypass|绕过).{0,80}(?:FLORAL|approval|审批|policy|权限)/iu, "policy-bypass-instruction"],
  ];
  for (const [pattern, label] of forbidden) if (pattern.test(text)) errors.push(`policy-forbidden:${label}`);
  if (files.some((file) => file.relativePath.startsWith("scripts/")) && !permissions.includes("shell.execute")) {
    errors.push("scripts-require-shell-execute-declaration");
  }
  if (/\b(?:npm|pnpm|yarn|pip|brew)\s+(?:add|install)\b/iu.test(text)
    && !permissions.includes("software.install")) {
    errors.push("install-instruction-requires-software-install-declaration");
  }
}

function computeTreeDigest(files: DraftFile[]): string {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.relativePath, "utf8");
    hash.update("\0", "utf8");
    hash.update(file.content);
    hash.update("\0", "utf8");
  }
  return `sha256:${hash.digest("hex")}`;
}

function safeJoin(root: string, relativePathValue: string): string {
  const output = resolve(root, ...relativePathValue.split("/"));
  const prefix = `${resolve(root)}${sep}`;
  if (!output.startsWith(prefix)) throw new Error("Skill file escaped staging root");
  return output;
}

function relativePath(root: string, path: string): string {
  const value = relative(root, path).split(sep).join("/");
  if (!value || value.startsWith("../") || value.includes("/../")) {
    throw new Error("Skill draft path escaped its root");
  }
  return value;
}

function validateSkillName(value: string): string {
  const normalized = value.trim();
  if (!isValidSkillName(normalized)) throw new Error("Invalid Project Skill name");
  return normalized;
}

function isValidSkillName(value: string): boolean {
  return value.length > 0
    && value.length <= MAX_SKILL_NAME_LENGTH
    && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value);
}

function stripScalarQuotes(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function readStringArray(raw: unknown, maximum: number, maxLength: number): string[] | undefined {
  if (!Array.isArray(raw) || raw.length > maximum) return undefined;
  const output = raw.flatMap((value) => {
    const text = readText(value, maxLength);
    return text ? [text] : [];
  });
  return output.length === raw.length && new Set(output).size === output.length ? output : undefined;
}

function readText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\u0000-\u001F\u007F]+/gu, " ").replace(/\s+/gu, " ").trim();
  return normalized && normalized.length <= maxLength ? normalized : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sanitizeReceiptText(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F]+/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 240);
}
