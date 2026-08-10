import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { readServiceState } from "../runtime/service-state.js";
import type {
  AgentSystemMaintenanceRequest,
  AgentSystemMaintenanceResult,
} from "../core/types.js";

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
}

export class SystemMaintenanceController {
  readonly #directory: string;
  readonly #serviceStatePath: string;
  readonly #workerPath: string;
  readonly #platform: NodeJS.Platform;
  readonly #now: () => Date;
  readonly #createId: () => string;
  readonly #spawnWorker: (command: string, args: string[]) => ChildProcess;
  #preparing = false;

  constructor(options: SystemMaintenanceControllerOptions) {
    this.#directory = resolve(options.directory);
    this.#serviceStatePath = resolve(options.serviceStatePath);
    this.#workerPath = resolve(options.workerPath);
    this.#platform = options.platform ?? process.platform;
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? (() => randomBytes(8).toString("hex").toUpperCase());
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
  }

  async prepare(request: AgentSystemMaintenanceRequest): Promise<PreparedSystemMaintenance> {
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
      };
      await writeSystemMaintenanceTransaction(this.#directory, transaction);
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
    try {
      const child = this.#spawnWorker(process.execPath, [
        this.#workerPath,
        "--directory", this.#directory,
        "--transaction", transaction.id,
        "--service-state", this.#serviceStatePath,
      ]);
      child.unref();
    } catch (error) {
      await writeSystemMaintenanceTransaction(this.#directory, {
        ...handoff,
        status: "failed",
        updatedAt: this.#now().toISOString(),
        errorType: safeErrorType(error),
      });
      throw error;
    }
  }

  async cancelQueued(
    transactionId: string,
    reason: "run-ended-before-handoff" | "final-reply-delivery-failed" = "run-ended-before-handoff",
  ): Promise<boolean> {
    const transaction = await readSystemMaintenanceTransaction(this.#directory, transactionId);
    if (!transaction || transaction.status !== "approved-queued") return false;
    await writeSystemMaintenanceTransaction(this.#directory, {
      ...transaction,
      status: "cancelled",
      updatedAt: this.#now().toISOString(),
      verification: undefined,
      cancellationReason: reason,
    });
    return true;
  }

  async readLatest(): Promise<SystemMaintenanceTransaction | undefined> {
    return await readLatestSystemMaintenanceTransaction(this.#directory);
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
