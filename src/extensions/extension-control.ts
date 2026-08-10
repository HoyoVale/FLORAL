import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { CURATED_EXTERNAL_MCP, type ExternalMcpCatalogId } from "./external-mcp-registry.js";
import { CURATED_EXTERNAL_SKILLS, type ExternalSkillCatalogId } from "../skills/external-skill-registry.js";
import type { SystemFactSnapshot, SystemSnapshot } from "../system-awareness/system-types.js";
import type { DurableJournal, DurableJournalStatus } from "../core/contracts.js";
import {
  extensionCapabilityForAction,
  type ExtensionMutationCapability,
} from "./extension-approval.js";

export const EXTENSION_CONTROL_SCHEMA_VERSION = 2 as const;

export type ExtensionControlKind = "external-mcp" | "external-skill" | "app";
export type ExtensionControlAction = "install" | "update" | "enable" | "disable" | "remove" | "install-handoff";
export type ExtensionControlStatus =
  | "pending-verification"
  | "pending-user-action"
  | "verified"
  | "prerequisite-required"
  | "degraded"
  | "failed"
  | "cancelled"
  | "superseded"
  | "rolled-back"
  | "expired";

export interface ExtensionControlTransaction {
  schemaVersion: typeof EXTENSION_CONTROL_SCHEMA_VERSION;
  id: string;
  kind: ExtensionControlKind;
  targetId: string;
  action: ExtensionControlAction;
  status: ExtensionControlStatus;
  requestedAt: string;
  updatedAt: string;
  changed?: boolean | undefined;
  expectedServerId?: string | undefined;
  expectedSkillNames?: string[] | undefined;
  verification?: string | undefined;
  errorType?: string | undefined;
  expiresAt?: string | undefined;
  supersededBy?: string | undefined;
}

export type ExtensionPlanIntent = "activate" | "update" | "disable" | "remove";
export type ExtensionPlanKind = "mcp" | "skill" | "app";
export type ExtensionPlanStatus =
  | "action-required"
  | "no-op"
  | "prerequisite-required"
  | "diagnose-first"
  | "user-handoff"
  | "unknown"
  | "unsupported";

export interface ExtensionPlan {
  kind: ExtensionPlanKind;
  id: string;
  intent: ExtensionPlanIntent;
  status: ExtensionPlanStatus;
  currentState: string;
  recommendedAction?: Exclude<ExtensionControlAction, "install-handoff"> | "prepare-app-install" | undefined;
  capability?: ExtensionMutationCapability | undefined;
  approval?: "chat-confirmation" | "user-mediated" | undefined;
  verificationInterface: string;
  prerequisite?: string | undefined;
  reason: string;
}

export interface ExtensionVerificationResult {
  transactionId: string;
  kind: ExtensionControlKind;
  targetId: string;
  action: ExtensionControlAction;
  status: ExtensionControlStatus;
  verification: string;
  evidence: readonly string[];
}

export function resolveExtensionControlDirectory(repositoryRoot: string, dataDir: string): string {
  return resolve(repositoryRoot, dataDir, "extension-control");
}

export class ExtensionControlLedger {
  readonly #directory: string;
  readonly #now: () => Date;
  readonly #createId: () => string;
  readonly #journal: DurableJournal | undefined;
  readonly #verificationTtlMs: number;
  readonly #userActionTtlMs: number;

  constructor(options: {
    directory: string;
    now?: (() => Date) | undefined;
    createId?: (() => string) | undefined;
    journal?: DurableJournal | undefined;
    verificationTtlMs?: number | undefined;
    userActionTtlMs?: number | undefined;
  }) {
    this.#directory = resolve(options.directory);
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? (() => randomBytes(8).toString("hex").toUpperCase());
    this.#journal = options.journal;
    this.#verificationTtlMs = positiveTtl(options.verificationTtlMs ?? 24 * 60 * 60 * 1_000);
    this.#userActionTtlMs = positiveTtl(options.userActionTtlMs ?? 7 * 24 * 60 * 60 * 1_000);
  }

  async initialize(): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    await mkdir(join(this.#directory, "transactions"), { recursive: true, mode: 0o700 });
    await chmod(this.#directory, 0o700).catch(() => undefined);
    await chmod(join(this.#directory, "transactions"), 0o700).catch(() => undefined);
    await this.reconcile();
    const latest = await readLatestExtensionControlTransaction(this.#directory);
    if (latest) this.#recordDurableState(latest);
  }

  async recordMutation(input: {
    kind: "external-mcp" | "external-skill" | "app";
    targetId: string;
    action: Exclude<ExtensionControlAction, "install-handoff">;
    changed: boolean;
    expectedServerId?: string | undefined;
    expectedSkillNames?: readonly string[] | undefined;
  }): Promise<ExtensionControlTransaction> {
    const nowDate = this.#now();
    const now = nowDate.toISOString();
    const id = this.#allocateId();
    await this.#supersedePending(input.kind, input.targetId, id);
    const transaction: ExtensionControlTransaction = {
      schemaVersion: EXTENSION_CONTROL_SCHEMA_VERSION,
      id,
      kind: input.kind,
      targetId: boundedId(input.targetId),
      action: input.action,
      status: "pending-verification",
      requestedAt: now,
      updatedAt: now,
      changed: input.changed,
      ...(input.expectedServerId ? { expectedServerId: boundedId(input.expectedServerId) } : {}),
      ...(input.expectedSkillNames && input.expectedSkillNames.length > 0
        ? { expectedSkillNames: [...new Set(input.expectedSkillNames.map(boundedSkillName))].sort() }
        : {}),
      verification: "fresh-turn-required",
      expiresAt: new Date(nowDate.getTime() + this.#verificationTtlMs).toISOString(),
    };
    await writeExtensionControlTransaction(this.#directory, transaction);
    this.#recordDurableState(transaction);
    return transaction;
  }

  async recordAppHandoff(appId: string): Promise<ExtensionControlTransaction> {
    const nowDate = this.#now();
    const now = nowDate.toISOString();
    const id = this.#allocateId();
    await this.#supersedePending("app", appId, id);
    const transaction: ExtensionControlTransaction = {
      schemaVersion: EXTENSION_CONTROL_SCHEMA_VERSION,
      id,
      kind: "app",
      targetId: boundedId(appId),
      action: "install-handoff",
      status: "pending-user-action",
      requestedAt: now,
      updatedAt: now,
      verification: "user-mediated-install-or-authentication-pending",
      expiresAt: new Date(nowDate.getTime() + this.#userActionTtlMs).toISOString(),
    };
    await writeExtensionControlTransaction(this.#directory, transaction);
    this.#recordDurableState(transaction);
    return transaction;
  }

  async recordFailure(input: {
    kind: "external-mcp" | "external-skill" | "app";
    targetId: string;
    action: Exclude<ExtensionControlAction, "install-handoff">;
    error: unknown;
  }): Promise<ExtensionControlTransaction> {
    const now = this.#now().toISOString();
    const id = this.#allocateId();
    await this.#supersedePending(input.kind, input.targetId, id);
    const transaction: ExtensionControlTransaction = {
      schemaVersion: EXTENSION_CONTROL_SCHEMA_VERSION,
      id,
      kind: input.kind,
      targetId: boundedId(input.targetId),
      action: input.action,
      status: "failed",
      requestedAt: now,
      updatedAt: now,
      verification: "mutation-failed-before-verification",
      errorType: safeErrorType(input.error),
    };
    await writeExtensionControlTransaction(this.#directory, transaction);
    this.#recordDurableState(transaction);
    return transaction;
  }

  async recordVerification(result: ExtensionVerificationResult): Promise<ExtensionControlTransaction | undefined> {
    const current = await readExtensionControlTransaction(this.#directory, result.transactionId);
    if (!current || isTerminalExtensionStatus(current.status)) return current;
    const next: ExtensionControlTransaction = {
      ...current,
      status: result.status,
      verification: result.verification,
      updatedAt: this.#now().toISOString(),
    };
    await writeExtensionControlTransaction(this.#directory, next);
    this.#recordDurableState(next);
    return next;
  }

  async latest(): Promise<ExtensionControlTransaction | undefined> {
    return await readLatestExtensionControlTransaction(this.#directory);
  }

  async get(id: string): Promise<ExtensionControlTransaction | undefined> {
    return await readExtensionControlTransaction(this.#directory, id);
  }

  async list(limit = 50): Promise<ExtensionControlTransaction[]> {
    return await listExtensionControlTransactions(this.#directory, limit);
  }

  async cancel(id: string): Promise<ExtensionControlTransaction | undefined> {
    return await this.#setTerminal(id, "cancelled", "cancelled-by-owner-or-host");
  }

  async markRolledBack(id: string): Promise<ExtensionControlTransaction | undefined> {
    return await this.#setTerminal(id, "rolled-back", "mutation-rolled-back");
  }

  async reconcile(): Promise<ExtensionControlTransaction[]> {
    const transactions = await listExtensionControlTransactions(this.#directory, 500);
    const now = this.#now().getTime();
    const expired: ExtensionControlTransaction[] = [];
    for (const transaction of transactions) {
      if (transaction.status !== "pending-verification" && transaction.status !== "pending-user-action") continue;
      const fallbackTtl = transaction.status === "pending-user-action"
        ? this.#userActionTtlMs
        : this.#verificationTtlMs;
      const expiresAt = transaction.expiresAt
        ? Date.parse(transaction.expiresAt)
        : Date.parse(transaction.requestedAt) + fallbackTtl;
      if (Number.isFinite(expiresAt) && expiresAt <= now) {
        const next = await this.#setTerminal(transaction.id, "expired", "verification-window-expired");
        if (next) expired.push(next);
      }
    }
    return expired;
  }

  async #supersedePending(
    kind: ExtensionControlKind,
    targetId: string,
    supersededBy: string,
  ): Promise<void> {
    const transactions = await listExtensionControlTransactions(this.#directory, 500);
    for (const transaction of transactions) {
      if (
        transaction.kind !== kind
        || transaction.targetId !== targetId
        || (transaction.status !== "pending-verification" && transaction.status !== "pending-user-action")
      ) continue;
      const next: ExtensionControlTransaction = {
        ...transaction,
        status: "superseded",
        supersededBy,
        verification: "superseded-by-newer-transaction",
        updatedAt: this.#now().toISOString(),
      };
      await writeExtensionControlTransaction(this.#directory, next);
      this.#recordDurableState(next);
    }
  }

  async #setTerminal(
    id: string,
    status: Extract<ExtensionControlStatus, "cancelled" | "rolled-back" | "expired">,
    verification: string,
  ): Promise<ExtensionControlTransaction | undefined> {
    const current = await readExtensionControlTransaction(this.#directory, id);
    if (!current || isTerminalExtensionStatus(current.status)) return current;
    const next: ExtensionControlTransaction = {
      ...current,
      status,
      verification,
      updatedAt: this.#now().toISOString(),
    };
    await writeExtensionControlTransaction(this.#directory, next);
    this.#recordDurableState(next);
    return next;
  }

  #allocateId(): string {
    const id = this.#createId().trim().toUpperCase();
    if (!/^[A-Z0-9]{8,24}$/u.test(id)) {
      throw new Error("Extension control id generator returned an invalid value");
    }
    return id;
  }

  #recordDurableState(transaction: ExtensionControlTransaction): void {
    this.#journal?.record({
      kind: "extension",
      idempotencyKey: `extension:${transaction.id}`,
      correlationId: transaction.id,
      status: extensionJournalStatus(transaction.status),
      eventType: `extension.${transaction.status}`,
      payload: {
        extensionKind: transaction.kind,
        targetId: transaction.targetId,
        action: transaction.action,
      },
      ...(transaction.status === "verified"
        ? { result: { verification: transaction.verification ?? "verified" } }
        : {}),
      ...(transaction.status === "failed"
        ? { errorCode: transaction.errorType ?? "extension-failed" }
        : {}),
    });
  }
}

function extensionJournalStatus(status: ExtensionControlStatus): DurableJournalStatus {
  if (status === "verified") return "completed";
  if (status === "failed" || status === "expired") return "failed";
  if (status === "cancelled" || status === "superseded" || status === "rolled-back") return "cancelled";
  return "waiting";
}

export function buildExtensionPlan(
  snapshot: SystemSnapshot,
  input: { kind: ExtensionPlanKind; id: string; intent?: ExtensionPlanIntent | undefined },
): ExtensionPlan {
  const id = input.id.trim();
  const intent = input.intent ?? "activate";
  if (input.kind === "mcp") return planMcp(snapshot, id, intent);
  if (input.kind === "skill") return planSkill(snapshot, id, intent);
  return planApp(snapshot, id, intent);
}

export function formatExtensionPlan(plan: ExtensionPlan): string {
  return [
    "FLORAL Controlled Extension Plan",
    `kind=${plan.kind}`,
    `id=${safeToken(plan.id)}`,
    `intent=${plan.intent}`,
    `status=${plan.status}`,
    `current_state=${safeToken(plan.currentState)}`,
    ...(plan.recommendedAction ? [`recommended_action=${plan.recommendedAction}`] : []),
    ...(plan.capability ? [`capability=${plan.capability}`] : []),
    ...(plan.approval ? [`approval=${plan.approval}`] : []),
    ...(plan.prerequisite ? [`prerequisite=${safeToken(plan.prerequisite)}`] : []),
    `reason=${JSON.stringify(plan.reason)}`,
    `verification_interface=${plan.verificationInterface}`,
    "execution_performed=false",
    "planning_semantics=plan-is-derived-from-frozen-system-evidence-and-curated-catalog-contracts",
    "authority_semantics=plan-does-not-grant-authorization-or-expand-the-curated-catalog",
  ].join("\n");
}

export function buildExtensionVerification(
  snapshot: SystemSnapshot,
  transaction: ExtensionControlTransaction,
): ExtensionVerificationResult {
  if (transaction.kind === "external-mcp") return verifyMcp(snapshot, transaction);
  if (transaction.kind === "external-skill") return verifySkill(snapshot, transaction);
  return verifyApp(snapshot, transaction);
}

export function formatExtensionVerification(result: ExtensionVerificationResult): string {
  return [
    "FLORAL Controlled Extension Verification",
    `transaction=${result.transactionId}`,
    `kind=${result.kind}`,
    `id=${safeToken(result.targetId)}`,
    `action=${result.action}`,
    `status=${result.status}`,
    `verification=${safeToken(result.verification)}`,
    ...result.evidence.map((entry) => `evidence=${JSON.stringify(entry)}`),
    "extension_mutation_performed=false",
    "verification_receipt_update=host-controlled-best-effort",
    "verification_semantics=fresh-turn-frozen-evidence-only",
    "unknown_semantics=absence-of-runtime-evidence-is-not-upgraded-by-guessing",
  ].join("\n");
}

export function readExtensionControlTransactionFromSnapshot(
  snapshot: SystemSnapshot,
  transactionId?: string | undefined,
): ExtensionControlTransaction | undefined {
  if (transactionId) {
    const history = fact(snapshot, "floral.extension_control", "recent_transactions");
    if (history?.resolution === "resolved" && Array.isArray(history.value)) {
      for (const value of history.value) {
        if (!isRecord(value) || value.id !== transactionId) continue;
        return transactionFromEvidenceRecord(value);
      }
    }
    return undefined;
  }
  const latest = fact(snapshot, "floral.extension_control", "last_transaction");
  if (!latest || latest.resolution !== "resolved" || !isRecord(latest.value)) return undefined;
  return transactionFromEvidenceRecord(latest.value);
}

export function readExtensionControlTransactionsFromSnapshot(
  snapshot: SystemSnapshot,
): ExtensionControlTransaction[] {
  const history = fact(snapshot, "floral.extension_control", "recent_transactions");
  if (history?.resolution !== "resolved" || !Array.isArray(history.value)) return [];
  return history.value
    .map((value) => isRecord(value) ? transactionFromEvidenceRecord(value) : undefined)
    .filter((value): value is ExtensionControlTransaction => Boolean(value));
}

export function formatExtensionControlHistory(
  transactions: readonly ExtensionControlTransaction[],
): string {
  return [
    "FLORAL Controlled Extension History",
    `count=${String(transactions.length)}`,
    ...transactions.flatMap((transaction, index) => [
      `transaction.${String(index + 1)}.id=${transaction.id}`,
      `transaction.${String(index + 1)}.kind=${transaction.kind}`,
      `transaction.${String(index + 1)}.target=${safeToken(transaction.targetId)}`,
      `transaction.${String(index + 1)}.action=${transaction.action}`,
      `transaction.${String(index + 1)}.status=${transaction.status}`,
      `transaction.${String(index + 1)}.updated_at=${transaction.updatedAt}`,
      `transaction.${String(index + 1)}.verification=${safeToken(transaction.verification ?? "none")}`,
    ]),
    "execution_performed=false",
  ].join("\n");
}

function transactionFromEvidenceRecord(
  value: Record<string, unknown>,
): ExtensionControlTransaction | undefined {
  const schemaVersion = value.schemaVersion === 1 || value.schemaVersion === EXTENSION_CONTROL_SCHEMA_VERSION
    ? EXTENSION_CONTROL_SCHEMA_VERSION
    : undefined;
  const id = stringValue(value.id);
  const kind = value.kind === "external-mcp" || value.kind === "external-skill" || value.kind === "app"
    ? value.kind
    : undefined;
  const targetId = stringValue(value.targetId);
  const action = isAction(value.action) ? value.action : undefined;
  const status = isStatus(value.status) ? value.status : undefined;
  const requestedAt = stringValue(value.requestedAt);
  const updatedAt = stringValue(value.updatedAt);
  if (!schemaVersion || !id || !kind || !targetId || !action || !status || !requestedAt || !updatedAt) {
    return undefined;
  }
  const changed = booleanValue(value.changed);
  const expectedServerId = stringValue(value.expectedServerId);
  const expectedSkillNames = Array.isArray(value.expectedSkillNames)
    ? value.expectedSkillNames.map(stringValue).filter((item): item is string => Boolean(item))
    : [];
  const verificationValue = stringValue(value.verification);
  const errorType = stringValue(value.errorType);
  const expiresAt = stringValue(value.expiresAt);
  const supersededBy = stringValue(value.supersededBy);
  const transaction: ExtensionControlTransaction = {
    schemaVersion,
    id,
    kind,
    targetId,
    action,
    status,
    requestedAt,
    updatedAt,
    ...(changed !== undefined ? { changed } : {}),
    ...(expectedServerId ? { expectedServerId } : {}),
    ...(expectedSkillNames.length > 0 ? { expectedSkillNames } : {}),
    ...(verificationValue ? { verification: verificationValue } : {}),
    ...(errorType ? { errorType } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(supersededBy ? { supersededBy } : {}),
  };
  return isTransaction(transaction) ? transaction : undefined;
}

export async function readLatestExtensionControlTransaction(
  directory: string,
): Promise<ExtensionControlTransaction | undefined> {
  try {
    return parseTransactionJson(await readFile(join(resolve(directory), "latest.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function readExtensionControlTransaction(
  directory: string,
  id: string,
): Promise<ExtensionControlTransaction | undefined> {
  const normalized = id.trim().toUpperCase();
  if (!/^[A-Z0-9]{8,24}$/u.test(normalized)) return undefined;
  try {
    return parseTransactionJson(
      await readFile(join(resolve(directory), "transactions", `${normalized}.json`), "utf8"),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function listExtensionControlTransactions(
  directory: string,
  limit = 50,
): Promise<ExtensionControlTransaction[]> {
  const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
  const root = join(resolve(directory), "transactions");
  let names: string[];
  try {
    names = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const transactions: ExtensionControlTransaction[] = [];
  for (const name of names) {
    if (!/^[A-Z0-9]{8,24}\.json$/u.test(name)) continue;
    transactions.push(parseTransactionJson(await readFile(join(root, name), "utf8")));
  }
  return transactions
    .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt) || b.id.localeCompare(a.id))
    .slice(0, boundedLimit);
}

export async function writeExtensionControlTransaction(
  directory: string,
  transaction: ExtensionControlTransaction,
): Promise<void> {
  validateTransaction(transaction);
  const root = resolve(directory);
  const transactions = join(root, "transactions");
  await mkdir(transactions, { recursive: true, mode: 0o700 });
  await writeAtomicPrivateJson(join(transactions, `${transaction.id}.json`), transaction);
  const latest = await readLatestExtensionControlTransaction(root);
  if (!latest || latest.id === transaction.id || transaction.requestedAt >= latest.requestedAt) {
    await writeAtomicPrivateJson(join(root, "latest.json"), transaction);
  }
}

function parseTransactionJson(text: string): ExtensionControlTransaction {
  const value = JSON.parse(text) as Record<string, unknown>;
  if (value.schemaVersion === 1) value.schemaVersion = EXTENSION_CONTROL_SCHEMA_VERSION;
  if (!isTransaction(value as Partial<ExtensionControlTransaction>)) {
    throw new Error("Invalid extension control transaction ledger");
  }
  const transaction = value as unknown as ExtensionControlTransaction;
  validateTransaction(transaction);
  return transaction;
}

function planMcp(snapshot: SystemSnapshot, id: string, intent: ExtensionPlanIntent): ExtensionPlan {
  if (!(id in CURATED_EXTERNAL_MCP)) return unsupported("mcp", id, intent, "The requested MCP is not in FLORAL's curated catalog.");
  const catalog = CURATED_EXTERNAL_MCP[id as ExternalMcpCatalogId];
  const packages = resolvedRows(snapshot, "extensions.external_mcp", "packages");
  if (!packages) return unknownPlan("mcp", id, intent, "External MCP registry evidence is unavailable.");
  const row = packages.find((entry) => stringValue(entry.id) === id);
  const installed = Boolean(row);
  const enabled = row ? booleanValue(row.enabled) === true : false;
  if (intent === "remove") {
    return installed ? actionPlan("mcp", id, intent, "installed", "remove") : noOp("mcp", id, intent, "absent", "The curated MCP is already absent.");
  }
  if (intent === "disable") {
    if (!installed) return noOp("mcp", id, intent, "absent", "The curated MCP is not installed.");
    return enabled ? actionPlan("mcp", id, intent, "enabled", "disable") : noOp("mcp", id, intent, "disabled", "The curated MCP is already disabled.");
  }
  if (intent === "update") return unsupported("mcp", id, intent, "Pinned MCP catalog updates are source-controlled and are not an Agent lifecycle action.");
  if (!installed) return actionPlan("mcp", id, intent, "absent", "install");
  if (!enabled) return actionPlan("mcp", id, intent, "disabled", "enable");

  const authRows = resolvedRows(snapshot, "extensions.external_mcp", "auth_presence");
  const auth = authRows?.find((entry) => stringValue(entry.id) === id);
  if (auth && stringValue(auth.requirement) !== "none" && booleanValue(auth.present) === false) {
    return {
      kind: "mcp", id, intent, status: "prerequisite-required", currentState: "enabled-auth-missing",
      verificationInterface: "floral_extensions/verify_extension",
      prerequisite: stringValue(auth.env) ?? "credential", reason: "The MCP is installed and enabled, but its required credential is not present. Installing again would not fix that prerequisite.",
    };
  }
  const servers = resolvedRows(snapshot, "codex.mcp", "servers");
  const server = servers?.find((entry) => stringValue(entry.name) === catalog.serverId);
  if (!server) {
    return {
      kind: "mcp", id, intent, status: "diagnose-first", currentState: "enabled-runtime-not-reported",
      verificationInterface: "floral_system/diagnose", reason: "The MCP registry says enabled, but Codex does not report the expected server. Diagnose runtime adoption before reinstalling or mutating it.",
    };
  }
  const status = stringValue(server.status) ?? "unknown";
  const tools = Array.isArray(server.tools) ? server.tools.length : 0;
  if (status === "ready" && tools > 0) return noOp("mcp", id, intent, "ready", "The curated MCP is installed, enabled, ready, and exposes tools.");
  return {
    kind: "mcp", id, intent, status: "diagnose-first", currentState: `enabled-runtime-${status}`,
    verificationInterface: "floral_system/diagnose", reason: "The MCP is already installed and enabled, so lifecycle mutation is not the next safe step; diagnose its runtime state first.",
  };
}

function planSkill(snapshot: SystemSnapshot, id: string, intent: ExtensionPlanIntent): ExtensionPlan {
  if (!(id in CURATED_EXTERNAL_SKILLS)) return unsupported("skill", id, intent, "The requested Skill package is not in FLORAL's curated catalog.");
  const packages = resolvedRows(snapshot, "extensions.external_skills", "packages");
  if (!packages) return unknownPlan("skill", id, intent, "External Skill registry evidence is unavailable.");
  const row = packages.find((entry) => stringValue(entry.id) === id);
  const installed = Boolean(row);
  const enabled = row ? booleanValue(row.enabled) === true : false;
  if (intent === "remove") return installed ? actionPlan("skill", id, intent, "installed", "remove") : noOp("skill", id, intent, "absent", "The curated Skill package is already absent.");
  if (intent === "disable") {
    if (!installed) return noOp("skill", id, intent, "absent", "The curated Skill package is not installed.");
    return enabled ? actionPlan("skill", id, intent, "enabled", "disable") : noOp("skill", id, intent, "disabled", "The curated Skill package is already disabled.");
  }
  if (intent === "update") {
    return installed ? actionPlan("skill", id, intent, enabled ? "enabled" : "disabled", "update") : unsupported("skill", id, intent, "Install the curated Skill package before updating it.");
  }
  if (!installed) return actionPlan("skill", id, intent, "absent", "install");
  if (!enabled) return actionPlan("skill", id, intent, "disabled", "enable");
  return noOp("skill", id, intent, "enabled", "The curated Skill package is already installed and enabled.");
}

function planApp(snapshot: SystemSnapshot, id: string, intent: ExtensionPlanIntent): ExtensionPlan {
  if (intent === "update" || intent === "remove") {
    return unsupported("app", id, intent, "App installation, update, removal, authentication, and grants remain upstream user-mediated actions.");
  }
  const installedFact = fact(snapshot, "codex.apps", "installed");
  if (!installedFact || installedFact.resolution !== "resolved") {
    return unknownPlan("app", id, intent, "Installed/callable App authority is unavailable or conflicting; directory visibility cannot be upgraded to installation state.");
  }
  const installed = rowsFromFact(installedFact) ?? [];
  const existing = installed.find((entry) => stringValue(entry.id) === id);
  if (existing) {
    const enabled = booleanValue(existing.enabled);
    if (intent === "disable") {
      return enabled === false
        ? noOp("app", id, intent, "installed-disabled", "The installed App is already disabled in effective Codex configuration.")
        : appActionPlan(id, intent, "installed-enabled", "disable");
    }
    if (enabled === false) return appActionPlan(id, intent, "installed-disabled", "enable");
    const callable = booleanValue(existing.callable);
    if (callable === true) return noOp("app", id, intent, "installed-callable", "The App is already installed and callable.");
    return {
      kind: "app", id, intent, status: "prerequisite-required", currentState: "installed-not-callable",
      approval: "user-mediated", verificationInterface: "floral_extensions/verify_extension",
      prerequisite: "upstream-authentication-or-grant", reason: "The App is installed but not currently callable; upstream authentication/grant state is user-mediated.",
    };
  }
  if (intent === "disable") return noOp("app", id, intent, "not-installed", "The App is not installed, so there is no enabled runtime state to disable.");
  const directory = resolvedRows(snapshot, "codex.apps", "directory");
  if (!directory) return unknownPlan("app", id, intent, "App directory authority is unavailable.");
  const candidate = directory.find((entry) => stringValue(entry.id) === id);
  if (!candidate) return unsupported("app", id, intent, "The requested App id is not visible in the current Codex App directory snapshot.");
  if (booleanValue(candidate.accessible) !== true || booleanValue(candidate.installSupported) !== true) {
    return unsupported("app", id, intent, "The App directory entry is not accessible through a supported install handoff in this snapshot.");
  }
  return {
    kind: "app", id, intent, status: "user-handoff", currentState: "directory-visible-not-installed",
    recommendedAction: "prepare-app-install", approval: "user-mediated", verificationInterface: "floral_extensions/verify_extension",
    reason: "Codex owns App installation/authentication. FLORAL can only prepare the supported install handoff; the user completes it upstream.",
  };
}

function verifyMcp(snapshot: SystemSnapshot, tx: ExtensionControlTransaction): ExtensionVerificationResult {
  const evidence: string[] = [];
  const packages = resolvedRows(snapshot, "extensions.external_mcp", "packages");
  if (!packages) return verification(tx, "pending-verification", "registry-evidence-unavailable", ["extensions.external_mcp/packages=unknown"]);
  const row = packages.find((entry) => stringValue(entry.id) === tx.targetId);
  evidence.push(`registry_present=${String(Boolean(row))}`);
  if (tx.action === "remove") {
    const server = expectedMcpServer(snapshot, tx);
    evidence.push(`runtime_reported=${String(Boolean(server))}`);
    return !row && !server
      ? verification(tx, "verified", "registry-and-runtime-absent", evidence)
      : verification(tx, "degraded", "remove-not-fully-adopted", evidence);
  }
  if (tx.action === "disable") {
    if (!row || booleanValue(row.enabled) !== false) return verification(tx, "degraded", "registry-disable-not-observed", evidence);
    const server = expectedMcpServer(snapshot, tx);
    evidence.push(`runtime_status=${stringValue(server?.status) ?? "absent"}`);
    return !server || stringValue(server.status) !== "ready"
      ? verification(tx, "verified", "registry-disabled-runtime-not-ready", evidence)
      : verification(tx, "degraded", "runtime-still-ready-after-disable", evidence);
  }
  if (!row || booleanValue(row.enabled) !== true) return verification(tx, "degraded", "registry-enabled-state-not-observed", evidence);
  evidence.push("registry_enabled=true");
  const authRows = resolvedRows(snapshot, "extensions.external_mcp", "auth_presence") ?? [];
  const auth = authRows.find((entry) => stringValue(entry.id) === tx.targetId);
  if (auth && stringValue(auth.requirement) !== "none" && booleanValue(auth.present) === false) {
    evidence.push("auth_present=false");
    return verification(tx, "prerequisite-required", "credential-required-before-runtime-verification", evidence);
  }
  const server = expectedMcpServer(snapshot, tx);
  if (!server) return verification(tx, "degraded", "runtime-server-not-reported", [...evidence, "runtime_reported=false"]);
  const status = stringValue(server.status) ?? "unknown";
  const tools = Array.isArray(server.tools) ? server.tools.length : 0;
  evidence.push(`runtime_status=${status}`, `tools=${String(tools)}`);
  if (status === "ready" && tools > 0) return verification(tx, "verified", "runtime-ready-with-tools", evidence);
  if (status === "starting") return verification(tx, "pending-verification", "runtime-still-starting", evidence);
  return verification(tx, "degraded", status === "ready" ? "runtime-ready-without-tools" : `runtime-${safeToken(status)}`, evidence);
}

function verifySkill(snapshot: SystemSnapshot, tx: ExtensionControlTransaction): ExtensionVerificationResult {
  const packages = resolvedRows(snapshot, "extensions.external_skills", "packages");
  if (!packages) return verification(tx, "pending-verification", "registry-evidence-unavailable", ["extensions.external_skills/packages=unknown"]);
  const row = packages.find((entry) => stringValue(entry.id) === tx.targetId);
  const evidence = [`registry_present=${String(Boolean(row))}`];
  const expected = tx.expectedSkillNames ?? [];
  const discovered = resolvedRows(snapshot, "codex.skills", "discovered");
  const discoveredNames = new Set((discovered ?? []).filter((entry) => booleanValue(entry.enabled) !== false).map((entry) => stringValue(entry.name)).filter((value): value is string => Boolean(value)));
  if (tx.action === "remove") {
    if (row) return verification(tx, "degraded", "registry-remove-not-observed", evidence);
    if (expected.length > 0 && expected.some((name) => discoveredNames.has(name))) {
      return verification(tx, "degraded", "removed-skill-still-discovered", [...evidence, "runtime_skill_still_present=true"]);
    }
    return verification(tx, "verified", "registry-absent-and-runtime-clean", evidence);
  }
  if (tx.action === "disable") {
    if (!row || booleanValue(row.enabled) !== false) return verification(tx, "degraded", "registry-disable-not-observed", evidence);
    if (expected.length > 0 && expected.some((name) => discoveredNames.has(name))) {
      return verification(tx, "degraded", "disabled-skill-still-discovered-enabled", [...evidence, "runtime_skill_still_present=true"]);
    }
    return verification(tx, "verified", "registry-disabled-and-runtime-not-enabled", evidence);
  }
  if (!row || booleanValue(row.enabled) !== true) return verification(tx, "degraded", "registry-enabled-state-not-observed", evidence);
  evidence.push("registry_enabled=true");
  if (expected.length === 0) return verification(tx, "pending-verification", "runtime-skill-name-set-unavailable", evidence);
  if (!discovered) return verification(tx, "pending-verification", "codex-skill-evidence-unavailable", evidence);
  const missing = expected.filter((name) => !discoveredNames.has(name));
  evidence.push(`expected_skills=${String(expected.length)}`, `missing_skills=${String(missing.length)}`);
  return missing.length === 0
    ? verification(tx, "verified", "codex-skills-discovered", evidence)
    : verification(tx, "degraded", "expected-skills-not-discovered", [...evidence, `missing=${missing.join(",")}`]);
}

function verifyApp(snapshot: SystemSnapshot, tx: ExtensionControlTransaction): ExtensionVerificationResult {
  const installedFact = fact(snapshot, "codex.apps", "installed");
  if (!installedFact || installedFact.resolution !== "resolved") {
    return verification(tx, "pending-user-action", "installed-authority-unavailable", [`codex.apps/installed=${installedFact?.resolution ?? "missing"}`]);
  }
  const rows = rowsFromFact(installedFact) ?? [];
  const row = rows.find((entry) => stringValue(entry.id) === tx.targetId);
  if (tx.action === "disable") {
    if (!row) return verification(tx, "verified", "app-not-installed-or-runtime-absent", ["installed=false"]);
    const enabled = booleanValue(row.enabled);
    const callable = booleanValue(row.callable);
    return enabled === false && callable !== true
      ? verification(tx, "verified", "app-disabled-and-not-callable", ["installed=true", "enabled=false", `callable=${String(callable ?? "unknown")}`])
      : verification(tx, "degraded", "app-disable-not-adopted", ["installed=true", `enabled=${String(enabled ?? "unknown")}`, `callable=${String(callable ?? "unknown")}`]);
  }
  if (!row) return verification(tx, "pending-user-action", "upstream-install-not-yet-observed", ["installed=false"]);
  if (tx.action === "enable" && booleanValue(row.enabled) !== true) {
    return verification(tx, "degraded", "app-enable-not-adopted", ["installed=true", `enabled=${String(booleanValue(row.enabled) ?? "unknown")}`]);
  }
  const callable = booleanValue(row.callable);
  if (callable === true) return verification(tx, "verified", "installed-and-callable", ["installed=true", "callable=true"]);
  return verification(tx, "prerequisite-required", "installed-but-upstream-auth-or-grant-pending", ["installed=true", `callable=${String(callable ?? "unknown")}`]);
}

function expectedMcpServer(snapshot: SystemSnapshot, tx: ExtensionControlTransaction): Record<string, unknown> | undefined {
  const serverId = tx.expectedServerId ?? ((tx.targetId in CURATED_EXTERNAL_MCP) ? CURATED_EXTERNAL_MCP[tx.targetId as ExternalMcpCatalogId].serverId : undefined);
  if (!serverId) return undefined;
  return resolvedRows(snapshot, "codex.mcp", "servers")?.find((entry) => stringValue(entry.name) === serverId);
}

function actionPlan(kind: "mcp" | "skill", id: string, intent: ExtensionPlanIntent, currentState: string, action: Exclude<ExtensionControlAction, "install-handoff">): ExtensionPlan {
  const capability = extensionCapabilityForAction(action);
  return { kind, id, intent, status: "action-required", currentState, recommendedAction: action, capability, approval: capability === "extension.enable" || capability === "extension.disable" ? undefined : "chat-confirmation", verificationInterface: "floral_extensions/verify_extension", reason: `The curated ${kind === "mcp" ? "MCP" : "Skill package"} lifecycle requires ${action} to satisfy the requested state.` };
}
function appActionPlan(id: string, intent: ExtensionPlanIntent, currentState: string, action: "enable" | "disable"): ExtensionPlan {
  const capability = extensionCapabilityForAction(action);
  return { kind: "app", id, intent, status: "action-required", currentState, recommendedAction: action, capability, verificationInterface: "floral_extensions/verify_extension", reason: `Codex App effective configuration requires ${action} to satisfy the requested state; authentication and connector grants remain upstream-owned.` };
}
function noOp(kind: ExtensionPlanKind, id: string, intent: ExtensionPlanIntent, currentState: string, reason: string): ExtensionPlan { return { kind, id, intent, status: "no-op", currentState, verificationInterface: "floral_extensions/verify_extension", reason }; }
function unknownPlan(kind: ExtensionPlanKind, id: string, intent: ExtensionPlanIntent, reason: string): ExtensionPlan { return { kind, id, intent, status: "unknown", currentState: "unknown", verificationInterface: "floral_extensions/verify_extension", reason }; }
function unsupported(kind: ExtensionPlanKind, id: string, intent: ExtensionPlanIntent, reason: string): ExtensionPlan { return { kind, id, intent, status: "unsupported", currentState: "unsupported", verificationInterface: "floral_extensions/verify_extension", reason }; }
function verification(tx: ExtensionControlTransaction, status: ExtensionControlStatus, value: string, evidence: readonly string[]): ExtensionVerificationResult { return { transactionId: tx.id, kind: tx.kind, targetId: tx.targetId, action: tx.action, status, verification: value, evidence }; }

function fact(snapshot: SystemSnapshot, componentId: string, factName: string): SystemFactSnapshot | undefined { return snapshot.components.find((component) => component.componentId === componentId)?.facts.find((item) => item.fact === factName); }
function resolvedRows(snapshot: SystemSnapshot, componentId: string, factName: string): Record<string, unknown>[] | undefined { const value = fact(snapshot, componentId, factName); return value?.resolution === "resolved" ? rowsFromFact(value) : undefined; }
function rowsFromFact(value: SystemFactSnapshot): Record<string, unknown>[] | undefined { return Array.isArray(value.value) ? value.value.filter(isRecord).map((entry) => entry as Record<string, unknown>) : undefined; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function stringValue(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function booleanValue(value: unknown): boolean | undefined { return typeof value === "boolean" ? value : undefined; }
function boundedId(value: string): string { const normalized = value.trim(); if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u.test(normalized)) throw new Error("Invalid extension target id"); return normalized; }
function boundedSkillName(value: string): string { const normalized = value.trim().slice(0, 160); if (!normalized || /[\u0000-\u001F\u007F]/u.test(normalized)) throw new Error("Invalid extension Skill name"); return normalized; }
function safeToken(value: string): string { const normalized = value.replace(/[^A-Za-z0-9._:@/+\-]/gu, "-").slice(0, 200); return normalized || "unknown"; }
function safeErrorType(error: unknown): string { const name = error instanceof Error ? error.name : "Error"; return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(name) ? name : "Error"; }

function isTransaction(value: Partial<ExtensionControlTransaction>): value is ExtensionControlTransaction {
  return value.schemaVersion === EXTENSION_CONTROL_SCHEMA_VERSION
    && typeof value.id === "string" && /^[A-Z0-9]{8,24}$/u.test(value.id)
    && (value.kind === "external-mcp" || value.kind === "external-skill" || value.kind === "app")
    && typeof value.targetId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u.test(value.targetId)
    && isAction(value.action) && isStatus(value.status)
    && typeof value.requestedAt === "string" && typeof value.updatedAt === "string"
    && (value.changed === undefined || typeof value.changed === "boolean")
    && (value.expectedServerId === undefined || (typeof value.expectedServerId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u.test(value.expectedServerId)))
    && (value.expectedSkillNames === undefined || (
      Array.isArray(value.expectedSkillNames)
      && value.expectedSkillNames.length <= 200
      && value.expectedSkillNames.every((name) => typeof name === "string" && name.length > 0 && name.length <= 160 && !/[\u0000-\u001F\u007F]/u.test(name))
    ))
    && (value.verification === undefined || (typeof value.verification === "string" && value.verification.length <= 240))
    && (value.errorType === undefined || (typeof value.errorType === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(value.errorType)))
    && (value.expiresAt === undefined || (typeof value.expiresAt === "string" && Number.isFinite(Date.parse(value.expiresAt))))
    && (value.supersededBy === undefined || (typeof value.supersededBy === "string" && /^[A-Z0-9]{8,24}$/u.test(value.supersededBy)));
}
function validateTransaction(value: ExtensionControlTransaction): void { if (!isTransaction(value) || !Number.isFinite(Date.parse(value.requestedAt)) || !Number.isFinite(Date.parse(value.updatedAt))) throw new Error("Invalid extension control transaction"); }
function isAction(value: unknown): value is ExtensionControlAction { return value === "install" || value === "update" || value === "enable" || value === "disable" || value === "remove" || value === "install-handoff"; }
function isStatus(value: unknown): value is ExtensionControlStatus { return value === "pending-verification" || value === "pending-user-action" || value === "verified" || value === "prerequisite-required" || value === "degraded" || value === "failed" || value === "cancelled" || value === "superseded" || value === "rolled-back" || value === "expired"; }
export function isTerminalExtensionStatus(status: ExtensionControlStatus): boolean { return status === "verified" || status === "failed" || status === "cancelled" || status === "superseded" || status === "rolled-back" || status === "expired"; }
function positiveTtl(value: number): number { if (!Number.isFinite(value) || value < 1_000) throw new Error("Extension control TTL must be at least 1000 ms"); return Math.trunc(value); }
async function writeAtomicPrivateJson(path: string, value: unknown): Promise<void> { await mkdir(dirname(path), { recursive: true, mode: 0o700 }); const temporary = `${path}.tmp-${String(process.pid)}-${Date.now().toString(36)}`; try { await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 }); await chmod(temporary, 0o600).catch(() => undefined); await rename(temporary, path); await chmod(path, 0o600).catch(() => undefined); } finally { await rm(temporary, { force: true }).catch(() => undefined); } }
