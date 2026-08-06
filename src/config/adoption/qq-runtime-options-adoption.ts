import { createHash } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { QqRuntimeOptionsContract } from "../qq/qq-runtime-options.js";
import { validateQqRuntimeOptionsContract } from "../qq/qq-runtime-options.js";

export type QqRuntimeAdoptionStatus = "active" | "rolled-back" | "failed";
export type QqRuntimeActiveOptions = "unified" | "legacy" | "none";

export interface QqRuntimeAdoptionReport {
  schemaVersion: 1;
  phase: "4.0E4";
  generatedAt: string;
  requestedMode: "unified";
  status: QqRuntimeAdoptionStatus;
  activeOptions: QqRuntimeActiveOptions;
  effectiveFingerprint: string;
  targetRuntimeFingerprint: string;
  activeRuntimeFingerprint?: string | undefined;
  installedSdkVersion: string;
  expectedSdkVersion: string;
  fallbackUsed: boolean;
  reasonCode:
    | "unified-ready"
    | "unified-start-failed-legacy-recovered"
    | "unified-and-legacy-start-failed";
  startupErrorType?: string | undefined;
  fallbackErrorType?: string | undefined;
  reportFingerprint: string;
}

export function createQqRuntimeAdoptionReport(input: {
  status: QqRuntimeAdoptionStatus;
  activeOptions: QqRuntimeActiveOptions;
  effectiveFingerprint: string;
  unified: QqRuntimeOptionsContract;
  legacy: QqRuntimeOptionsContract;
  installedSdkVersion: string;
  fallbackUsed: boolean;
  reasonCode: QqRuntimeAdoptionReport["reasonCode"];
  startupError?: unknown;
  fallbackError?: unknown;
  now?: Date | undefined;
}): QqRuntimeAdoptionReport {
  validateQqRuntimeOptionsContract(input.unified);
  validateQqRuntimeOptionsContract(input.legacy);
  const activeRuntimeFingerprint = input.activeOptions === "unified"
    ? input.unified.runtimeFingerprint
    : input.activeOptions === "legacy"
      ? input.legacy.runtimeFingerprint
      : undefined;
  const withoutFingerprint = {
    schemaVersion: 1 as const,
    phase: "4.0E4" as const,
    generatedAt: (input.now ?? new Date()).toISOString(),
    requestedMode: "unified" as const,
    status: input.status,
    activeOptions: input.activeOptions,
    effectiveFingerprint: input.effectiveFingerprint,
    targetRuntimeFingerprint: input.unified.runtimeFingerprint,
    ...(activeRuntimeFingerprint ? { activeRuntimeFingerprint } : {}),
    installedSdkVersion: input.installedSdkVersion,
    expectedSdkVersion: input.unified.expectedVersion,
    fallbackUsed: input.fallbackUsed,
    reasonCode: input.reasonCode,
    ...(input.startupError ? { startupErrorType: safeErrorType(input.startupError) } : {}),
    ...(input.fallbackError ? { fallbackErrorType: safeErrorType(input.fallbackError) } : {}),
  };
  return {
    ...withoutFingerprint,
    reportFingerprint: fingerprint({
      ...withoutFingerprint,
      generatedAt: "<generated-at>",
    }),
  };
}

export function assessQqRuntimeAdoptionReport(
  report: QqRuntimeAdoptionReport,
  current: QqRuntimeOptionsContract,
  installedSdkVersion: string,
): "active" | "rolled-back" | "failed" | "drift" {
  validateQqRuntimeOptionsContract(current);
  if (
    report.targetRuntimeFingerprint !== current.runtimeFingerprint
    || report.expectedSdkVersion !== current.expectedVersion
    || report.installedSdkVersion !== installedSdkVersion
  ) {
    return "drift";
  }
  if (
    report.status === "active"
    && report.activeOptions === "unified"
    && report.activeRuntimeFingerprint === current.runtimeFingerprint
    && !report.fallbackUsed
  ) {
    return "active";
  }
  if (report.status === "rolled-back" && report.activeOptions === "legacy") {
    return "rolled-back";
  }
  if (report.status === "failed") return "failed";
  return "drift";
}

export async function writeQqRuntimeAdoptionReport(
  repositoryRoot: string,
  report: QqRuntimeAdoptionReport,
): Promise<string> {
  const path = qqRuntimeAdoptionReportPath(repositoryRoot);
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
    await syncDirectory(directory);
  } finally {
    await rm(temporary, { force: true });
  }
  return path;
}

export async function readQqRuntimeAdoptionReport(
  repositoryRoot: string,
): Promise<QqRuntimeAdoptionReport | undefined> {
  const path = qqRuntimeAdoptionReportPath(repositoryRoot);
  try {
    const report = JSON.parse(await readFile(path, "utf8")) as QqRuntimeAdoptionReport;
    if (!isValidReport(report)) throw new Error("Invalid QQ runtime adoption report");
    const { reportFingerprint, ...withoutFingerprint } = report;
    const expected = fingerprint({
      ...withoutFingerprint,
      generatedAt: "<generated-at>",
    });
    if (reportFingerprint !== expected) {
      throw new Error("Invalid QQ runtime adoption report fingerprint");
    }
    return report;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

export async function removeQqRuntimeAdoptionReport(repositoryRoot: string): Promise<void> {
  await rm(qqRuntimeAdoptionReportPath(repositoryRoot), { force: true });
}

export function renderQqRuntimeAdoptionReport(report: QqRuntimeAdoptionReport): string {
  return [
    `config.qq_adoption.schema_version=${String(report.schemaVersion)}`,
    `config.qq_adoption.phase=${report.phase}`,
    `config.qq_adoption.requested_mode=${report.requestedMode}`,
    `config.qq_adoption.status=${report.status}`,
    `config.qq_adoption.active_options=${report.activeOptions}`,
    `config.qq_adoption.effective_fingerprint=${report.effectiveFingerprint}`,
    `config.qq_adoption.target_runtime_fingerprint=${report.targetRuntimeFingerprint}`,
    `config.qq_adoption.active_runtime_fingerprint=${report.activeRuntimeFingerprint ?? "unavailable"}`,
    `config.qq_adoption.expected_sdk_version=${report.expectedSdkVersion}`,
    `config.qq_adoption.installed_sdk_version=${report.installedSdkVersion}`,
    `config.qq_adoption.fallback_used=${String(report.fallbackUsed)}`,
    `config.qq_adoption.reason=${report.reasonCode}`,
    `config.qq_adoption.startup_error=${report.startupErrorType ?? "none"}`,
    `config.qq_adoption.fallback_error=${report.fallbackErrorType ?? "none"}`,
    `config.qq_adoption.report_fingerprint=${report.reportFingerprint}`,
    "config.qq_adoption=ok",
    "",
  ].join("\n");
}

export function qqRuntimeAdoptionReportPath(repositoryRoot: string): string {
  return join(resolve(repositoryRoot), "data/config/adoption/qq-runtime-options.json");
}

function isValidReport(report: QqRuntimeAdoptionReport): boolean {
  const fingerprints = [
    report.effectiveFingerprint,
    report.targetRuntimeFingerprint,
    report.reportFingerprint,
  ];
  if (
    report.schemaVersion !== 1
    || report.phase !== "4.0E4"
    || report.requestedMode !== "unified"
    || !["active", "rolled-back", "failed"].includes(report.status)
    || !["unified", "legacy", "none"].includes(report.activeOptions)
    || !fingerprints.every(isSha256)
    || (report.activeRuntimeFingerprint !== undefined && !isSha256(report.activeRuntimeFingerprint))
    || typeof report.installedSdkVersion !== "string"
    || report.installedSdkVersion.trim() === ""
    || typeof report.expectedSdkVersion !== "string"
    || report.expectedSdkVersion.trim() === ""
    || typeof report.fallbackUsed !== "boolean"
    || Number.isNaN(Date.parse(report.generatedAt))
  ) {
    return false;
  }
  if (report.status === "active") {
    return report.activeOptions === "unified"
      && !report.fallbackUsed
      && report.reasonCode === "unified-ready"
      && report.activeRuntimeFingerprint === report.targetRuntimeFingerprint;
  }
  if (report.status === "rolled-back") {
    return report.activeOptions === "legacy"
      && report.fallbackUsed
      && report.reasonCode === "unified-start-failed-legacy-recovered"
      && isSha256(report.activeRuntimeFingerprint);
  }
  return report.activeOptions === "none"
    && report.fallbackUsed
    && report.reasonCode === "unified-and-legacy-start-failed"
    && report.activeRuntimeFingerprint === undefined;
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is not portable to every Windows filesystem.
  }
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    )).join(",")}}`;
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
  if (error instanceof Error && error.name.trim()) {
    return error.name.replace(/[^A-Za-z0-9_.-]/gu, "_").slice(0, 80) || "Error";
  }
  return "Error";
}
