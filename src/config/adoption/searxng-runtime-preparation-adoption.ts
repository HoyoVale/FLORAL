import { createHash } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { SearxngRuntimeObservation } from "../../search/searxng-runtime-observation.js";
import type { SearxngRuntimePreparationContract } from "../search/searxng-runtime-preparation.js";

export type SearxngRuntimeAdoptionStatus = "active" | "rolled-back" | "failed";
export type SearxngActivePreparation = "unified" | "legacy" | "none";

export interface SearxngRuntimeAdoptionReport {
  schemaVersion: 1;
  phase: "4.0E5";
  generatedAt: string;
  requestedMode: "unified";
  status: SearxngRuntimeAdoptionStatus;
  activePreparation: SearxngActivePreparation;
  effectiveFingerprint: string;
  targetRuntimeFingerprint: string;
  activeRuntimeFingerprint?: string | undefined;
  image: string;
  observedConfigFingerprint?: string | undefined;
  observedEngineCount: number;
  observedPluginCount: number;
  observedCategoryCount: number;
  fallbackUsed: boolean;
  reasonCode:
    | "unified-observed"
    | "unified-failed-legacy-recovered"
    | "unified-and-legacy-failed";
  startupErrorType?: string | undefined;
  fallbackErrorType?: string | undefined;
  reportFingerprint: string;
}

export function createSearxngRuntimeAdoptionReport(input: {
  status: SearxngRuntimeAdoptionStatus;
  activePreparation: SearxngActivePreparation;
  effectiveFingerprint: string;
  target: SearxngRuntimePreparationContract;
  active?: SearxngRuntimePreparationContract | undefined;
  observation?: SearxngRuntimeObservation | undefined;
  fallbackUsed: boolean;
  reasonCode: SearxngRuntimeAdoptionReport["reasonCode"];
  startupError?: unknown;
  fallbackError?: unknown;
  now?: Date | undefined;
}): SearxngRuntimeAdoptionReport {
  const observation = input.observation;
  const withoutFingerprint = {
    schemaVersion: 1 as const,
    phase: "4.0E5" as const,
    generatedAt: (input.now ?? new Date()).toISOString(),
    requestedMode: "unified" as const,
    status: input.status,
    activePreparation: input.activePreparation,
    effectiveFingerprint: input.effectiveFingerprint,
    targetRuntimeFingerprint: input.target.runtimeFingerprint,
    ...(input.active ? { activeRuntimeFingerprint: input.active.runtimeFingerprint } : {}),
    image: input.target.image,
    ...(observation?.status === "observed" && observation.fingerprint
      ? { observedConfigFingerprint: observation.fingerprint }
      : {}),
    observedEngineCount: observation?.engines.length ?? 0,
    observedPluginCount: observation?.plugins.length ?? 0,
    observedCategoryCount: observation?.categories.length ?? 0,
    fallbackUsed: input.fallbackUsed,
    reasonCode: input.reasonCode,
    ...(input.startupError ? { startupErrorType: safeErrorType(input.startupError) } : {}),
    ...(input.fallbackError ? { fallbackErrorType: safeErrorType(input.fallbackError) } : {}),
  };
  return {
    ...withoutFingerprint,
    reportFingerprint: fingerprint({ ...withoutFingerprint, generatedAt: "<generated-at>" }),
  };
}

export function assessSearxngRuntimeAdoptionReport(
  report: SearxngRuntimeAdoptionReport,
  current: SearxngRuntimePreparationContract,
  observation?: SearxngRuntimeObservation | undefined,
): "active" | "rolled-back" | "failed" | "drift" {
  if (
    report.targetRuntimeFingerprint !== current.runtimeFingerprint
    || report.image !== current.image
  ) return "drift";

  if (
    report.status === "active"
    && report.activePreparation === "unified"
    && report.activeRuntimeFingerprint === current.runtimeFingerprint
    && !report.fallbackUsed
  ) {
    if (!observation) return "active";
    if (observation.status !== "observed" || !observation.fingerprint) return "drift";
    return report.observedConfigFingerprint === observation.fingerprint ? "active" : "drift";
  }
  if (report.status === "rolled-back" && report.activePreparation === "legacy") return "rolled-back";
  if (report.status === "failed") return "failed";
  return "drift";
}

export async function writeSearxngRuntimeAdoptionReport(
  repositoryRoot: string,
  report: SearxngRuntimeAdoptionReport,
): Promise<string> {
  const path = searxngRuntimeAdoptionReportPath(repositoryRoot);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
  const temporary = `${path}.tmp-${String(process.pid)}-${Date.now().toString(36)}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await chmod(temporary, 0o600).catch(() => undefined);
    await rename(temporary, path);
    await chmod(path, 0o600).catch(() => undefined);
  } finally {
    await rm(temporary, { force: true });
  }
  return path;
}

export async function readSearxngRuntimeAdoptionReport(
  repositoryRoot: string,
): Promise<SearxngRuntimeAdoptionReport | undefined> {
  const path = searxngRuntimeAdoptionReportPath(repositoryRoot);
  try {
    const report = JSON.parse(await readFile(path, "utf8")) as SearxngRuntimeAdoptionReport;
    if (!isValidReport(report)) throw new Error("Invalid SearXNG runtime adoption report");
    const { reportFingerprint, ...withoutFingerprint } = report;
    const expected = fingerprint({ ...withoutFingerprint, generatedAt: "<generated-at>" });
    if (reportFingerprint !== expected) throw new Error("Invalid SearXNG runtime adoption report fingerprint");
    return report;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

export async function removeSearxngRuntimeAdoptionReport(repositoryRoot: string): Promise<void> {
  await rm(searxngRuntimeAdoptionReportPath(repositoryRoot), { force: true });
}

export function renderSearxngRuntimeAdoptionReport(report: SearxngRuntimeAdoptionReport): string {
  return [
    `config.searxng_adoption.schema_version=${String(report.schemaVersion)}`,
    `config.searxng_adoption.phase=${report.phase}`,
    `config.searxng_adoption.requested_mode=${report.requestedMode}`,
    `config.searxng_adoption.status=${report.status}`,
    `config.searxng_adoption.active_preparation=${report.activePreparation}`,
    `config.searxng_adoption.effective_fingerprint=${report.effectiveFingerprint}`,
    `config.searxng_adoption.target_runtime_fingerprint=${report.targetRuntimeFingerprint}`,
    `config.searxng_adoption.active_runtime_fingerprint=${report.activeRuntimeFingerprint ?? "unavailable"}`,
    `config.searxng_adoption.image=${report.image}`,
    `config.searxng_adoption.observed_config_fingerprint=${report.observedConfigFingerprint ?? "unavailable"}`,
    `config.searxng_adoption.engines=${String(report.observedEngineCount)}`,
    `config.searxng_adoption.plugins=${String(report.observedPluginCount)}`,
    `config.searxng_adoption.categories=${String(report.observedCategoryCount)}`,
    `config.searxng_adoption.fallback_used=${String(report.fallbackUsed)}`,
    `config.searxng_adoption.reason=${report.reasonCode}`,
    `config.searxng_adoption.startup_error=${report.startupErrorType ?? "none"}`,
    `config.searxng_adoption.fallback_error=${report.fallbackErrorType ?? "none"}`,
    `config.searxng_adoption.report_fingerprint=${report.reportFingerprint}`,
    "config.searxng_adoption=ok",
    "",
  ].join("\n");
}

export function searxngRuntimeAdoptionReportPath(repositoryRoot: string): string {
  return join(resolve(repositoryRoot), "data/config/adoption/searxng-runtime-preparation.json");
}

function isValidReport(report: SearxngRuntimeAdoptionReport): boolean {
  if (
    report.schemaVersion !== 1
    || report.phase !== "4.0E5"
    || report.requestedMode !== "unified"
    || !["active", "rolled-back", "failed"].includes(report.status)
    || !["unified", "legacy", "none"].includes(report.activePreparation)
    || !isSha256(report.targetRuntimeFingerprint)
    || !isSha256(report.reportFingerprint)
    || (report.activeRuntimeFingerprint !== undefined && !isSha256(report.activeRuntimeFingerprint))
    || (report.observedConfigFingerprint !== undefined && !isSha256(report.observedConfigFingerprint))
    || typeof report.image !== "string"
    || typeof report.fallbackUsed !== "boolean"
    || !Number.isInteger(report.observedEngineCount)
    || !Number.isInteger(report.observedPluginCount)
    || !Number.isInteger(report.observedCategoryCount)
    || Number.isNaN(Date.parse(report.generatedAt))
  ) return false;
  if (report.status === "active") {
    return report.activePreparation === "unified"
      && !report.fallbackUsed
      && report.reasonCode === "unified-observed"
      && report.activeRuntimeFingerprint === report.targetRuntimeFingerprint
      && isSha256(report.observedConfigFingerprint);
  }
  if (report.status === "rolled-back") {
    return report.activePreparation === "legacy"
      && report.fallbackUsed
      && report.reasonCode === "unified-failed-legacy-recovered";
  }
  return report.activePreparation === "none"
    && report.fallbackUsed
    && report.reasonCode === "unified-and-legacy-failed";
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function safeErrorType(error: unknown): string {
  return error instanceof Error && error.name.trim() !== "" ? error.name : "Error";
}
