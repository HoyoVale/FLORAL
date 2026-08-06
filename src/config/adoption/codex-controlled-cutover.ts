import { createHash } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  fingerprintCodexConfigSemantics,
  type CodexShadowReport,
} from "./codex-shadow-adoption.js";
import { normalizeNativeConfigText } from "../adapters/native-config-types.js";

export type CodexCutoverStatus = "active" | "rolled-back" | "failed";
export type CodexActiveConfig = "unified" | "legacy" | "none";

export interface CodexCutoverReport {
  schemaVersion: 1;
  phase: "4.0E2";
  generatedAt: string;
  requestedMode: "unified";
  status: CodexCutoverStatus;
  activeConfig: CodexActiveConfig;
  effectiveFingerprint: string;
  targetCodexConfigFingerprint: string;
  activeCodexConfigFingerprint?: string | undefined;
  shadowReportFingerprint: string;
  legacyConfigSha256: string;
  unifiedConfigSha256: string;
  fallbackUsed: boolean;
  reasonCode:
    | "unified-started"
    | "unified-start-failed-legacy-recovered"
    | "unified-and-legacy-start-failed";
  startupErrorType?: string | undefined;
  fallbackErrorType?: string | undefined;
  reportFingerprint: string;
}

export interface CreateCodexCutoverReportInput {
  status: CodexCutoverStatus;
  activeConfig: CodexActiveConfig;
  effectiveFingerprint: string;
  legacyConfig: string;
  unifiedConfig: string;
  shadowReport: CodexShadowReport;
  fallbackUsed: boolean;
  reasonCode: CodexCutoverReport["reasonCode"];
  startupError?: unknown;
  fallbackError?: unknown;
  now?: Date | undefined;
}

export function createCodexCutoverReport(
  input: CreateCodexCutoverReportInput,
): CodexCutoverReport {
  const targetCodexConfigFingerprint = fingerprintCodexConfigSemantics(
    input.unifiedConfig,
  );
  const activeConfigValue = input.activeConfig === "unified"
    ? input.unifiedConfig
    : input.activeConfig === "legacy"
      ? input.legacyConfig
      : undefined;
  const reportWithoutFingerprint = {
    schemaVersion: 1 as const,
    phase: "4.0E2" as const,
    generatedAt: (input.now ?? new Date()).toISOString(),
    requestedMode: "unified" as const,
    status: input.status,
    activeConfig: input.activeConfig,
    effectiveFingerprint: input.effectiveFingerprint,
    targetCodexConfigFingerprint,
    ...(activeConfigValue
      ? { activeCodexConfigFingerprint: fingerprintCodexConfigSemantics(activeConfigValue) }
      : {}),
    shadowReportFingerprint: input.shadowReport.reportFingerprint,
    legacyConfigSha256: sha256(normalizeNativeConfigText(input.legacyConfig)),
    unifiedConfigSha256: sha256(normalizeNativeConfigText(input.unifiedConfig)),
    fallbackUsed: input.fallbackUsed,
    reasonCode: input.reasonCode,
    ...(input.startupError ? { startupErrorType: safeErrorType(input.startupError) } : {}),
    ...(input.fallbackError ? { fallbackErrorType: safeErrorType(input.fallbackError) } : {}),
  };
  return {
    ...reportWithoutFingerprint,
    reportFingerprint: sha256(stableStringify({
      ...reportWithoutFingerprint,
      generatedAt: "<generated-at>",
    })),
  };
}

export function assessCodexCutoverReport(
  report: CodexCutoverReport,
  currentUnifiedConfig: string,
): "active" | "rolled-back" | "failed" | "drift" {
  const currentFingerprint = fingerprintCodexConfigSemantics(currentUnifiedConfig);
  if (report.targetCodexConfigFingerprint !== currentFingerprint) return "drift";
  if (
    report.status === "active"
    && report.activeConfig === "unified"
    && report.activeCodexConfigFingerprint === currentFingerprint
    && !report.fallbackUsed
  ) {
    return "active";
  }
  if (report.status === "rolled-back" && report.activeConfig === "legacy") {
    return "rolled-back";
  }
  if (report.status === "failed") return "failed";
  return "drift";
}

export async function writeCodexCutoverReport(
  repositoryRoot: string,
  report: CodexCutoverReport,
): Promise<string> {
  const path = codexCutoverReportPath(repositoryRoot);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = `${path}.tmp-${String(process.pid)}-${Date.now().toString(36)}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
    await syncDirectory(directory);
  } finally {
    await rm(temporary, { force: true });
  }
  return path;
}

export async function readCodexCutoverReport(
  repositoryRoot: string,
): Promise<CodexCutoverReport | undefined> {
  const path = codexCutoverReportPath(repositoryRoot);
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as CodexCutoverReport;
    if (!isValidCodexCutoverReport(parsed)) {
      throw new Error("Invalid Codex cutover report");
    }
    const { reportFingerprint, ...withoutFingerprint } = parsed;
    const expected = sha256(stableStringify({
      ...withoutFingerprint,
      generatedAt: "<generated-at>",
    }));
    if (reportFingerprint !== expected) {
      throw new Error("Invalid Codex cutover report fingerprint");
    }
    return parsed;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

export async function removeCodexCutoverReport(
  repositoryRoot: string,
): Promise<void> {
  await rm(codexCutoverReportPath(repositoryRoot), { force: true });
}

export function renderCodexCutoverReport(report: CodexCutoverReport): string {
  return [
    `config.codex_cutover.schema_version=${String(report.schemaVersion)}`,
    `config.codex_cutover.phase=${report.phase}`,
    `config.codex_cutover.requested_mode=${report.requestedMode}`,
    `config.codex_cutover.status=${report.status}`,
    `config.codex_cutover.active_config=${report.activeConfig}`,
    `config.codex_cutover.effective_fingerprint=${report.effectiveFingerprint}`,
    `config.codex_cutover.target_codex_config_fingerprint=${report.targetCodexConfigFingerprint}`,
    `config.codex_cutover.active_codex_config_fingerprint=${report.activeCodexConfigFingerprint ?? "unavailable"}`,
    `config.codex_cutover.shadow_report_fingerprint=${report.shadowReportFingerprint}`,
    `config.codex_cutover.fallback_used=${String(report.fallbackUsed)}`,
    `config.codex_cutover.reason=${report.reasonCode}`,
    `config.codex_cutover.startup_error=${report.startupErrorType ?? "none"}`,
    `config.codex_cutover.fallback_error=${report.fallbackErrorType ?? "none"}`,
    `config.codex_cutover.report_fingerprint=${report.reportFingerprint}`,
    "config.codex_cutover=ok",
    "",
  ].join("\n");
}

export function codexCutoverReportPath(repositoryRoot: string): string {
  return join(resolve(repositoryRoot), "data/config/adoption/codex-cutover.json");
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
    // Directory fsync is not portable to every Windows filesystem. The file
    // itself has already been synced before the atomic rename.
  }
}

function isValidCodexCutoverReport(report: CodexCutoverReport): boolean {
  const fingerprints = [
    report.effectiveFingerprint,
    report.targetCodexConfigFingerprint,
    report.shadowReportFingerprint,
    report.legacyConfigSha256,
    report.unifiedConfigSha256,
    report.reportFingerprint,
  ];
  if (
    report.schemaVersion !== 1
    || report.phase !== "4.0E2"
    || report.requestedMode !== "unified"
    || !["active", "rolled-back", "failed"].includes(report.status)
    || !["unified", "legacy", "none"].includes(report.activeConfig)
    || !fingerprints.every(isSha256)
    || typeof report.fallbackUsed !== "boolean"
    || Number.isNaN(Date.parse(report.generatedAt))
    || (report.activeCodexConfigFingerprint !== undefined
      && !isSha256(report.activeCodexConfigFingerprint))
    || (report.startupErrorType !== undefined && typeof report.startupErrorType !== "string")
    || (report.fallbackErrorType !== undefined && typeof report.fallbackErrorType !== "string")
  ) {
    return false;
  }
  if (report.status === "active") {
    return report.activeConfig === "unified"
      && !report.fallbackUsed
      && report.reasonCode === "unified-started"
      && report.activeCodexConfigFingerprint === report.targetCodexConfigFingerprint;
  }
  if (report.status === "rolled-back") {
    return report.activeConfig === "legacy"
      && report.fallbackUsed
      && report.reasonCode === "unified-start-failed-legacy-recovered"
      && isSha256(report.activeCodexConfigFingerprint);
  }
  return report.activeConfig === "none"
    && report.fallbackUsed
    && report.reasonCode === "unified-and-legacy-start-failed"
    && report.activeCodexConfigFingerprint === undefined;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function safeErrorType(error: unknown): string {
  if (error instanceof Error && error.name) return sanitize(error.name);
  return "Error";
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/gu, "_").slice(0, 80) || "Error";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
