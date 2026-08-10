import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  defaultMaintenanceAutonomyState,
  maintenanceModeAllows,
  maintenanceModeAtMost,
  normalizeAutomaticActionTimestamps,
  readMaintenanceAutonomyState,
  writeMaintenanceAutonomyState,
  type MaintenanceAutonomyMachinePolicy,
  type MaintenanceAutonomyMode,
  type MaintenanceAutonomyStatus,
  type MaintenanceAutonomyTrigger,
} from "./maintenance-autonomy.js";
import { readServiceState } from "../runtime/service-state.js";
import type {
  AgentSystemMaintenanceRequest,
  AgentSystemMaintenanceResult,
} from "../core/types.js";
import type { DurableJournal, DurableJournalStatus } from "../core/contracts.js";

export const SYSTEM_MAINTENANCE_SCHEMA_VERSION = 1 as const;

export function resolveSystemMaintenanceDirectory(repositoryRoot: string, dataDir: string): string {
  return resolve(repositoryRoot, dataDir, "system-maintenance");
}
export type SystemMaintenanceStatus =
  | "approved-queued"
  | "handoff"
  | "running"
  | "verified"
  | "failed"
  | "cancelled";

export interface SystemMaintenanceTransaction {
  schemaVersion: typeof SYSTEM_MAINTENANCE_SCHEMA_VERSION;
  id: string;
  componentId: "floral.service";
  actionId: "restart";
  status: SystemMaintenanceStatus;
  requestedAt: string;
  updatedAt: string;
  previousPid?: number | undefined;
  resultingPid?: number | undefined;
  verification?: "pending" | "service-ready-new-pid" | undefined;
  cancellationReason?: "run-ended-before-handoff" | "final-reply-delivery-failed" | undefined;
  errorType?: string | undefined;
  trigger?: MaintenanceAutonomyTrigger | undefined;
  diagnosticFindingIds?: string[] | undefined;
  notificationStatus?: "pending" | "delivered" | "failed" | undefined;
  notificationUpdatedAt?: string | undefined;
  repairOutcome?: "resolved" | "persistent" | "action-failed" | undefined;
}

export interface PreparedSystemMaintenance {
  result: AgentSystemMaintenanceResult;
  transactionId?: string | undefined;
}

export interface SystemMaintenanceControllerOptions {
  directory: string;
  serviceStatePath: string;
  workerPath: string;
  platform?: NodeJS.Platform | undefined;
  now?: (() => Date) | undefined;
  createId?: (() => string) | undefined;
  spawnWorker?: ((command: string, args: string[]) => ChildProcess) | undefined;
  autonomy?: MaintenanceAutonomyMachinePolicy | undefined;
  durableJournal?: DurableJournal | undefined;
  recoveryTimeoutMs?: number | undefined;
}

export class SystemMaintenanceController {
  readonly #directory: string;
  readonly #serviceStatePath: string;
  readonly #workerPath: string;
  readonly #platform: NodeJS.Platform;
  readonly #now: () => Date;
  readonly #createId: () => string;
  readonly #spawnWorker: (command: string, args: string[]) => ChildProcess;
  readonly #autonomy: MaintenanceAutonomyMachinePolicy;
  readonly #durableJournal: DurableJournal | undefined;
  readonly #recoveryTimeoutMs: number;
  #preparing = false;

  constructor(options: SystemMaintenanceControllerOptions) {
    this.#directory = resolve(options.directory);
    this.#serviceStatePath = resolve(options.serviceStatePath);
    this.#workerPath = resolve(options.workerPath);
    this.#platform = options.platform ?? process.platform;
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? (() => randomBytes(8).toString("hex").toUpperCase());
    this.#autonomy = options.autonomy ?? {
      ceiling: "manual",
      allowedActions: ["floral.service.restart"],
      maxAutomaticActionsPerHour: 2,
      cooldownMs: 300_000,
      failureThreshold: 2,
      selfHealIntervalMs: 60_000,
    };
    this.#durableJournal = options.durableJournal;
    this.#recoveryTimeoutMs = options.recoveryTimeoutMs ?? 120_000;
    if (!Number.isSafeInteger(this.#recoveryTimeoutMs) || this.#recoveryTimeoutMs < 90_000) {
      throw new Error("Maintenance recovery timeout must be at least 90000 milliseconds");
    }
    this.#spawnWorker = options.spawnWorker ?? ((command, args) => spawn(command, args, {
      detached: true,
      stdio: "ignore",
      // The restart verifier does not need model/provider credentials. Keep the
      // detached worker's environment intentionally tiny so a host-lifecycle
      // helper never inherits FLORAL's secret-bearing process environment.
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin" },
    }));
  }

  get directory(): string {
    return this.#directory;
  }

  async initialize(): Promise<void> {
    await mkdir(this.#transactionsDirectory(), { recursive: true, mode: 0o700 });
    await chmod(this.#directory, 0o700).catch(() => undefined);
    await chmod(this.#transactionsDirectory(), 0o700).catch(() => undefined);
    const autonomyState = await this.#ensureAutonomyState();
    const clamped = maintenanceModeAtMost(autonomyState.requestedMode, this.#autonomy.ceiling);
    if (clamped !== autonomyState.requestedMode) {
      await writeMaintenanceAutonomyState(this.#directory, {
        ...autonomyState,
        requestedMode: clamped,
        updatedAt: this.#now().toISOString(),
      });
    }
    await this.#reconcileInterruptedTransaction();
    await this.#reconcileLatestAutomaticTransaction();
    const latest = await this.readLatest();
    if (latest) this.#recordDurableState(latest);
  }

  async autonomyStatus(): Promise<MaintenanceAutonomyStatus> {
    await this.#reconcileInterruptedTransaction();
    await this.#reconcileLatestAutomaticTransaction();
    const now = this.#now();
    const state = await this.#ensureAutonomyState();
    const automaticActionTimestamps = normalizeAutomaticActionTimestamps(
      state.automaticActionTimestamps,
      now.getTime(),
    );
    const lastAutomaticActionAt = automaticActionTimestamps.at(-1);
    return {
      requestedMode: state.requestedMode,
      effectiveMode: maintenanceModeAtMost(state.requestedMode, this.#autonomy.ceiling),
      ceiling: this.#autonomy.ceiling,
      allowedActions: this.#autonomy.allowedActions,
      maxAutomaticActionsPerHour: this.#autonomy.maxAutomaticActionsPerHour,
      cooldownMs: this.#autonomy.cooldownMs,
      failureThreshold: this.#autonomy.failureThreshold,
      selfHealIntervalMs: this.#autonomy.selfHealIntervalMs,
      recentAutomaticActions: automaticActionTimestamps.length,
      consecutiveSelfHealFailures: state.consecutiveSelfHealFailures,
      circuitBreakerOpen: state.circuitBreakerOpen,
      ...(lastAutomaticActionAt ? { lastAutomaticActionAt } : {}),
      ...(state.lastOwnerDeliveryConversationId
        ? { lastOwnerDeliveryConversationId: state.lastOwnerDeliveryConversationId }
        : {}),
    };
  }

  async setAutonomyMode(mode: MaintenanceAutonomyMode): Promise<{ status: "updated" | "denied"; reason?: string; policy: MaintenanceAutonomyStatus }> {
    const state = await this.#ensureAutonomyState();
    if (maintenanceModeAtMost(mode, this.#autonomy.ceiling) !== mode) {
      return { status: "denied", reason: "machine-ceiling", policy: await this.autonomyStatus() };
    }
    const next = { ...state, requestedMode: mode, updatedAt: this.#now().toISOString() };
    await writeMaintenanceAutonomyState(this.#directory, next);
    return { status: "updated", policy: await this.autonomyStatus() };
  }

  async resetCircuitBreaker(): Promise<MaintenanceAutonomyStatus> {
    const state = await this.#ensureAutonomyState();
    await writeMaintenanceAutonomyState(this.#directory, {
      ...state,
      consecutiveSelfHealFailures: 0,
      circuitBreakerOpen: false,
      updatedAt: this.#now().toISOString(),
    });
    return await this.autonomyStatus();
  }

  async recordOwnerDeliveryTarget(conversationId: string): Promise<void> {
    const normalized = conversationId.trim().slice(0, 512);
    if (!normalized) return;
    const state = await this.#ensureAutonomyState();
    if (state.lastOwnerDeliveryConversationId === normalized) return;
    await writeMaintenanceAutonomyState(this.#directory, {
      ...state,
      lastOwnerDeliveryConversationId: normalized,
      updatedAt: this.#now().toISOString(),
    });
  }

  async automaticApprovalAllowed(required: "owner-auto" | "self-heal"): Promise<{ allowed: boolean; reason: string }> {
    const policy = await this.autonomyStatus();
    if (!maintenanceModeAllows(policy.effectiveMode, required)) return { allowed: false, reason: "autonomy-mode" };
    if (required === "self-heal" && policy.circuitBreakerOpen) return { allowed: false, reason: "circuit-breaker-open" };
    if (policy.recentAutomaticActions >= policy.maxAutomaticActionsPerHour) return { allowed: false, reason: "rate-limit" };
    if (policy.lastAutomaticActionAt) {
      const elapsed = this.#now().getTime() - Date.parse(policy.lastAutomaticActionAt);
      if (Number.isFinite(elapsed) && elapsed < policy.cooldownMs) return { allowed: false, reason: "cooldown" };
    }
    return { allowed: true, reason: "policy" };
  }

  async prepare(
    request: AgentSystemMaintenanceRequest,
    context: { trigger?: MaintenanceAutonomyTrigger; diagnosticFindingIds?: string[] } = {},
  ): Promise<PreparedSystemMaintenance> {
    if (request.componentId !== "floral.service" || request.actionId !== "restart") {
      return { result: { status: "denied", reason: "unsupported-management-action" } };
    }
    if (this.#platform !== "darwin") {
      return { result: { status: "denied", reason: "host-lifecycle-unavailable" } };
    }
    const rationale = sanitizeRationale(request.rationale);
    if (!rationale) {
      return { result: { status: "denied", reason: "maintenance-rationale-required" } };
    }
    if (this.#preparing) {
      return { result: { status: "denied", reason: "maintenance-preparation-in-progress" } };
    }

    this.#preparing = true;
    try {
      await this.initialize();
      const active = await this.readLatest();
      if (
        active?.status === "approved-queued"
        || active?.status === "handoff"
        || active?.status === "running"
      ) {
        return {
          transactionId: active.id,
          result: {
            status: "denied",
            transactionId: active.id,
            reason: "maintenance-already-in-progress",
          },
        };
      }

      const trigger = context.trigger ?? "manual";
      if (trigger !== "manual") {
        const automatic = await this.automaticApprovalAllowed(trigger === "self-heal" ? "self-heal" : "owner-auto");
        if (!automatic.allowed) return { result: { status: "denied", reason: `autonomy-${automatic.reason}` } };
      }

      const previous = await readServiceState(this.#serviceStatePath);
      const now = this.#now().toISOString();
      const id = this.#allocateId();
      const transaction: SystemMaintenanceTransaction = {
        schemaVersion: SYSTEM_MAINTENANCE_SCHEMA_VERSION,
        id,
        componentId: "floral.service",
        actionId: "restart",
        status: "approved-queued",
        requestedAt: now,
        updatedAt: now,
        ...(previous?.pid ? { previousPid: previous.pid } : {}),
        verification: "pending",
        trigger,
        ...(context.diagnosticFindingIds?.length
          ? { diagnosticFindingIds: context.diagnosticFindingIds.slice(0, 8).map((value) => value.slice(0, 160)) }
          : {}),
        ...(trigger === "self-heal" ? { notificationStatus: "pending" as const } : {}),
      };
      await writeSystemMaintenanceTransaction(this.#directory, transaction);
      this.#recordDurableState(transaction);
      if (trigger !== "manual") await this.#recordAutomaticAction(now);
      return {
        transactionId: id,
        result: {
          status: "queued",
          transactionId: id,
          message: "approved-and-queued-for-post-reply-handoff",
        },
      };
    } finally {
      this.#preparing = false;
    }
  }

  async execute(transactionId: string): Promise<void> {
    const transaction = await readSystemMaintenanceTransaction(this.#directory, transactionId);
    if (!transaction || transaction.status !== "approved-queued") {
      throw new Error("System maintenance transaction is not executable");
    }
    const handoff: SystemMaintenanceTransaction = {
      ...transaction,
      status: "handoff",
      updatedAt: this.#now().toISOString(),
    };
    await writeSystemMaintenanceTransaction(this.#directory, handoff);
    this.#recordDurableState(handoff);
    try {
      const child = this.#spawnWorker(process.execPath, [
        this.#workerPath,
        "--directory", this.#directory,
        "--transaction", transaction.id,
        "--service-state", this.#serviceStatePath,
      ]);
      child.unref();
    } catch (error) {
      const failed: SystemMaintenanceTransaction = {
        ...handoff,
        status: "failed",
        updatedAt: this.#now().toISOString(),
        errorType: safeErrorType(error),
      };
      await writeSystemMaintenanceTransaction(this.#directory, failed);
      this.#recordDurableState(failed);
      throw error;
    }
  }

  async cancelQueued(
    transactionId: string,
    reason: "run-ended-before-handoff" | "final-reply-delivery-failed" = "run-ended-before-handoff",
  ): Promise<boolean> {
    const transaction = await readSystemMaintenanceTransaction(this.#directory, transactionId);
    if (!transaction || transaction.status !== "approved-queued") return false;
    const cancelled: SystemMaintenanceTransaction = {
      ...transaction,
      status: "cancelled",
      updatedAt: this.#now().toISOString(),
      verification: undefined,
      cancellationReason: reason,
    };
    await writeSystemMaintenanceTransaction(this.#directory, cancelled);
    this.#recordDurableState(cancelled);
    return true;
  }

  async readLatest(): Promise<SystemMaintenanceTransaction | undefined> {
    return await readLatestSystemMaintenanceTransaction(this.#directory);
  }

  async markNotificationDelivered(transactionId: string, delivered: boolean): Promise<void> {
    const transaction = await readSystemMaintenanceTransaction(this.#directory, transactionId);
    if (!transaction || transaction.trigger !== "self-heal") return;
    await writeSystemMaintenanceTransaction(this.#directory, {
      ...transaction,
      notificationStatus: delivered ? "delivered" : "failed",
      notificationUpdatedAt: this.#now().toISOString(),
    });
  }

  async pendingSelfHealNotification(): Promise<SystemMaintenanceTransaction | undefined> {
    const latest = await this.readLatest();
    return latest?.trigger === "self-heal"
      && (latest.status === "failed" || (latest.status === "verified" && Boolean(latest.repairOutcome)))
      && latest.notificationStatus !== "delivered"
      ? latest
      : undefined;
  }

  async reconcileSelfHealOutcome(activeFindingIds: readonly string[]): Promise<void> {
    const latest = await this.readLatest();
    if (!latest || latest.trigger !== "self-heal") return;
    const state = await this.#ensureAutonomyState();
    if (state.lastReconciledTransactionId === latest.id) return;

    if (latest.status === "failed") {
      const failures = state.consecutiveSelfHealFailures + 1;
      await writeSystemMaintenanceTransaction(this.#directory, {
        ...latest,
        repairOutcome: "action-failed",
      });
      await writeMaintenanceAutonomyState(this.#directory, {
        ...state,
        consecutiveSelfHealFailures: failures,
        circuitBreakerOpen: failures >= this.#autonomy.failureThreshold,
        lastReconciledTransactionId: latest.id,
        updatedAt: this.#now().toISOString(),
      });
      return;
    }
    if (latest.status !== "verified") return;

    const original = latest.diagnosticFindingIds ?? [];
    if (original.length === 0) return;
    const active = new Set(activeFindingIds);
    const persistent = original.some((id) => active.has(id));
    const failures = persistent ? state.consecutiveSelfHealFailures + 1 : 0;
    await writeSystemMaintenanceTransaction(this.#directory, {
      ...latest,
      repairOutcome: persistent ? "persistent" : "resolved",
    });
    await writeMaintenanceAutonomyState(this.#directory, {
      ...state,
      consecutiveSelfHealFailures: failures,
      circuitBreakerOpen: persistent && failures >= this.#autonomy.failureThreshold,
      lastReconciledTransactionId: latest.id,
      updatedAt: this.#now().toISOString(),
    });
  }

  async #ensureAutonomyState() {
    const existing = await readMaintenanceAutonomyState(this.#directory);
    if (existing) return existing;
    const created = defaultMaintenanceAutonomyState(this.#now());
    await writeMaintenanceAutonomyState(this.#directory, created);
    return created;
  }

  async #recordAutomaticAction(timestamp: string): Promise<void> {
    const state = await this.#ensureAutonomyState();
    const values = normalizeAutomaticActionTimestamps(
      [...state.automaticActionTimestamps, timestamp],
      this.#now().getTime(),
    );
    await writeMaintenanceAutonomyState(this.#directory, {
      ...state,
      automaticActionTimestamps: values,
      updatedAt: this.#now().toISOString(),
    });
  }

  async #reconcileLatestAutomaticTransaction(): Promise<void> {
    const latest = await this.readLatest();
    if (!latest || latest.trigger !== "self-heal" || latest.status !== "failed") return;
    const state = await this.#ensureAutonomyState();
    if (state.lastReconciledTransactionId === latest.id) return;
    const failures = state.consecutiveSelfHealFailures + 1;
    await writeSystemMaintenanceTransaction(this.#directory, {
      ...latest,
      repairOutcome: "action-failed",
    });
    await writeMaintenanceAutonomyState(this.#directory, {
      ...state,
      consecutiveSelfHealFailures: failures,
      circuitBreakerOpen: failures >= this.#autonomy.failureThreshold,
      lastReconciledTransactionId: latest.id,
      updatedAt: this.#now().toISOString(),
    });
  }

  async #reconcileInterruptedTransaction(): Promise<void> {
    const latest = await this.readLatest();
    if (!latest || (latest.status !== "handoff" && latest.status !== "running")) return;
    const updatedAt = Date.parse(latest.updatedAt);
    if (!Number.isFinite(updatedAt) || this.#now().getTime() - updatedAt < this.#recoveryTimeoutMs) return;
    const failed: SystemMaintenanceTransaction = {
      ...latest,
      status: "failed",
      updatedAt: this.#now().toISOString(),
      errorType: "MaintenanceRecoveryTimeout",
    };
    await writeSystemMaintenanceTransaction(this.#directory, failed);
    this.#recordDurableState(failed);
  }

  #transactionsDirectory(): string {
    return join(this.#directory, "transactions");
  }

  #allocateId(): string {
    const id = this.#createId().trim().toUpperCase();
    if (!/^[A-Z0-9]{8,24}$/u.test(id)) {
      throw new Error("System maintenance id generator returned an invalid value");
    }
    return id;
  }

  #recordDurableState(transaction: SystemMaintenanceTransaction): void {
    this.#durableJournal?.record({
      kind: "maintenance",
      idempotencyKey: `maintenance:${transaction.id}`,
      correlationId: transaction.id,
      status: maintenanceJournalStatus(transaction.status),
      eventType: `maintenance.${transaction.status}`,
      payload: {
        componentId: transaction.componentId,
        actionId: transaction.actionId,
        trigger: transaction.trigger ?? "manual",
      },
      ...(transaction.status === "verified"
        ? { result: { verification: transaction.verification ?? "verified" } }
        : {}),
      ...(transaction.status === "failed"
        ? { errorCode: transaction.errorType ?? "maintenance-failed" }
        : {}),
    });
  }
}

function maintenanceJournalStatus(status: SystemMaintenanceStatus): DurableJournalStatus {
  if (status === "approved-queued") return "accepted";
  if (status === "handoff" || status === "running") return "waiting";
  if (status === "verified") return "completed";
  return status;
}

export async function readLatestSystemMaintenanceTransaction(
  directory: string,
): Promise<SystemMaintenanceTransaction | undefined> {
  return await readTransactionPath(join(resolve(directory), "latest.json"));
}

export async function readSystemMaintenanceTransaction(
  directory: string,
  transactionId: string,
): Promise<SystemMaintenanceTransaction | undefined> {
  if (!/^[A-Z0-9]{8,24}$/u.test(transactionId)) return undefined;
  return await readTransactionPath(
    join(resolve(directory), "transactions", `${transactionId}.json`),
  );
}

export async function writeSystemMaintenanceTransaction(
  directory: string,
  transaction: SystemMaintenanceTransaction,
): Promise<void> {
  validateTransaction(transaction);
  const root = resolve(directory);
  const transactions = join(root, "transactions");
  await mkdir(transactions, { recursive: true, mode: 0o700 });
  await Promise.all([
    writeAtomicPrivateJson(join(transactions, `${transaction.id}.json`), transaction),
    writeAtomicPrivateJson(join(root, "latest.json"), transaction),
  ]);
}

async function readTransactionPath(path: string): Promise<SystemMaintenanceTransaction | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<SystemMaintenanceTransaction>;
    if (!isTransaction(parsed)) return undefined;
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}

function isTransaction(value: Partial<SystemMaintenanceTransaction>): value is SystemMaintenanceTransaction {
  return value.schemaVersion === SYSTEM_MAINTENANCE_SCHEMA_VERSION
    && typeof value.id === "string"
    && /^[A-Z0-9]{8,24}$/u.test(value.id)
    && value.componentId === "floral.service"
    && value.actionId === "restart"
    && isStatus(value.status)
    && typeof value.requestedAt === "string"
    && typeof value.updatedAt === "string";
}

function validateTransaction(value: SystemMaintenanceTransaction): void {
  if (!isTransaction(value)) throw new Error("Invalid system maintenance transaction");
  if (!Number.isFinite(Date.parse(value.requestedAt)) || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new Error("Invalid system maintenance timestamp");
  }
}

function isStatus(value: unknown): value is SystemMaintenanceStatus {
  return value === "approved-queued"
    || value === "handoff"
    || value === "running"
    || value === "verified"
    || value === "failed"
    || value === "cancelled";
}

async function writeAtomicPrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${String(process.pid)}-${Date.now().toString(36)}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600).catch(() => undefined);
    await rename(temporary, path);
    await chmod(path, 0o600).catch(() => undefined);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function sanitizeRationale(value: string): string {
  return value.replace(/[\u0000-\u001F\u007F]+/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 320);
}

function safeErrorType(error: unknown): string {
  const name = error instanceof Error ? error.name : "Error";
  return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(name) ? name : "Error";
}
