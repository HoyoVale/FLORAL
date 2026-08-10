import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const MAINTENANCE_AUTONOMY_SCHEMA_VERSION = 1 as const;

export type MaintenanceAutonomyMode = "manual" | "owner-auto" | "self-heal";
export type MaintenanceAutonomyTrigger = "manual" | "owner-auto" | "self-heal";

export interface MaintenanceAutonomyMachinePolicy {
  ceiling: MaintenanceAutonomyMode;
  allowedActions: readonly ["floral.service.restart"];
  maxAutomaticActionsPerHour: number;
  cooldownMs: number;
  failureThreshold: number;
  selfHealIntervalMs: number;
}

export interface MaintenanceAutonomyState {
  schemaVersion: typeof MAINTENANCE_AUTONOMY_SCHEMA_VERSION;
  requestedMode: MaintenanceAutonomyMode;
  updatedAt: string;
  automaticActionTimestamps: string[];
  consecutiveSelfHealFailures: number;
  circuitBreakerOpen: boolean;
  lastReconciledTransactionId?: string | undefined;
  lastOwnerDeliveryConversationId?: string | undefined;
}

export interface MaintenanceAutonomyStatus {
  requestedMode: MaintenanceAutonomyMode;
  effectiveMode: MaintenanceAutonomyMode;
  ceiling: MaintenanceAutonomyMode;
  allowedActions: readonly ["floral.service.restart"];
  maxAutomaticActionsPerHour: number;
  cooldownMs: number;
  failureThreshold: number;
  selfHealIntervalMs: number;
  recentAutomaticActions: number;
  consecutiveSelfHealFailures: number;
  circuitBreakerOpen: boolean;
  lastAutomaticActionAt?: string | undefined;
  lastOwnerDeliveryConversationId?: string | undefined;
}

const MODE_RANK: Record<MaintenanceAutonomyMode, number> = {
  manual: 0,
  "owner-auto": 1,
  "self-heal": 2,
};

export async function readMaintenanceAutonomyStatus(
  directory: string,
  policy: MaintenanceAutonomyMachinePolicy,
  now: Date = new Date(),
): Promise<MaintenanceAutonomyStatus> {
  const state = await readMaintenanceAutonomyState(directory) ?? defaultMaintenanceAutonomyState(now);
  const timestamps = normalizeAutomaticActionTimestamps(state.automaticActionTimestamps, now.getTime());
  const lastAutomaticActionAt = timestamps.at(-1);
  return {
    requestedMode: state.requestedMode,
    effectiveMode: maintenanceModeAtMost(state.requestedMode, policy.ceiling),
    ceiling: policy.ceiling,
    allowedActions: policy.allowedActions,
    maxAutomaticActionsPerHour: policy.maxAutomaticActionsPerHour,
    cooldownMs: policy.cooldownMs,
    failureThreshold: policy.failureThreshold,
    selfHealIntervalMs: policy.selfHealIntervalMs,
    recentAutomaticActions: timestamps.length,
    consecutiveSelfHealFailures: state.consecutiveSelfHealFailures,
    circuitBreakerOpen: state.circuitBreakerOpen,
    ...(lastAutomaticActionAt ? { lastAutomaticActionAt } : {}),
    ...(state.lastOwnerDeliveryConversationId ? { lastOwnerDeliveryConversationId: state.lastOwnerDeliveryConversationId } : {}),
  };
}

export function maintenanceModeAtMost(
  requested: MaintenanceAutonomyMode,
  ceiling: MaintenanceAutonomyMode,
): MaintenanceAutonomyMode {
  return MODE_RANK[requested] <= MODE_RANK[ceiling] ? requested : ceiling;
}

export function maintenanceModeAllows(
  effective: MaintenanceAutonomyMode,
  required: Exclude<MaintenanceAutonomyMode, "manual">,
): boolean {
  return MODE_RANK[effective] >= MODE_RANK[required];
}

export function resolveMaintenanceAutonomyStatePath(directory: string): string {
  return join(resolve(directory), "autonomy-state.json");
}

export async function readMaintenanceAutonomyState(
  directory: string,
): Promise<MaintenanceAutonomyState | undefined> {
  const path = resolveMaintenanceAutonomyStatePath(directory);
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<MaintenanceAutonomyState>;
    return isState(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function writeMaintenanceAutonomyState(
  directory: string,
  state: MaintenanceAutonomyState,
): Promise<void> {
  if (!isState(state)) throw new Error("Invalid maintenance autonomy state");
  const path = resolveMaintenanceAutonomyStatePath(directory);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${String(process.pid)}-${Date.now().toString(36)}`;
  try {
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600).catch(() => undefined);
    await rename(temporary, path);
    await chmod(path, 0o600).catch(() => undefined);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export function defaultMaintenanceAutonomyState(now: Date): MaintenanceAutonomyState {
  return {
    schemaVersion: MAINTENANCE_AUTONOMY_SCHEMA_VERSION,
    requestedMode: "manual",
    updatedAt: now.toISOString(),
    automaticActionTimestamps: [],
    consecutiveSelfHealFailures: 0,
    circuitBreakerOpen: false,
  };
}

export function normalizeAutomaticActionTimestamps(
  values: readonly string[],
  nowMs: number,
): string[] {
  const cutoff = nowMs - 60 * 60_000;
  return values.filter((value) => {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && timestamp >= cutoff && timestamp <= nowMs + 60_000;
  });
}

export function isExplicitOwnerServiceRestartRequest(text: string): boolean {
  const normalized = text
    .replace(/[\u0000-\u001F\u007F]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
  if (!normalized || normalized.length > 120) return false;
  if (/(?:不要|别|无需|不需要|如果|若|假如|when\b|if\b|do not\b|don't\b|without\b)/iu.test(normalized)) {
    return false;
  }
  if (/^(?:(?:请|麻烦|帮我|现在|立即|马上|给我|可以)\s*)*(?:重启|重新启动)(?:\s*(?:一下|floral|floral\s*服务|服务))?[。.!！]?$/iu.test(normalized)) {
    return true;
  }
  return /^(?:please\s+)?(?:restart|reboot)(?:\s+(?:the\s+)?(?:floral|floral\s+service|service))?[.!]?$/iu.test(normalized);
}

function isState(value: Partial<MaintenanceAutonomyState>): value is MaintenanceAutonomyState {
  return value.schemaVersion === MAINTENANCE_AUTONOMY_SCHEMA_VERSION
    && isMode(value.requestedMode)
    && typeof value.updatedAt === "string"
    && Array.isArray(value.automaticActionTimestamps)
    && value.automaticActionTimestamps.every((entry) => typeof entry === "string")
    && Number.isInteger(value.consecutiveSelfHealFailures)
    && Number(value.consecutiveSelfHealFailures) >= 0
    && typeof value.circuitBreakerOpen === "boolean"
    && (value.lastReconciledTransactionId === undefined || typeof value.lastReconciledTransactionId === "string")
    && (value.lastOwnerDeliveryConversationId === undefined || typeof value.lastOwnerDeliveryConversationId === "string");
}

export function isMaintenanceAutonomyMode(value: unknown): value is MaintenanceAutonomyMode {
  return isMode(value);
}

function isMode(value: unknown): value is MaintenanceAutonomyMode {
  return value === "manual" || value === "owner-auto" || value === "self-heal";
}
