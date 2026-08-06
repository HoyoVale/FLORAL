import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  CODEX_BRIDGE_BASE_URL_PLACEHOLDER,
  renderCodexConfig,
} from "../adapters/codex-native-config.js";
import { normalizeNativeConfigText } from "../adapters/native-config-types.js";
import {
  resolveConfigurationAuthority,
  type ResolvedConfigurationAuthority,
} from "../federation/config-authority.js";

export type CodexConfigAdoptionMode = "legacy" | "unified-shadow";

export interface CodexShadowReport {
  schemaVersion: 2;
  phase: "4.0E1";
  generatedAt: string;
  mode: "unified-shadow";
  status: "compatible" | "drift";
  effectiveFingerprint: string;
  codexConfigFingerprint: string;
  legacyConfigSha256: string;
  unifiedConfigSha256: string;
  sharedAssignments: number;
  expectedUnifiedOnlyAssignments: string[];
  missingExpectedUnifiedOnlyAssignments: string[];
  unexpectedUnifiedOnlyAssignments: string[];
  legacyOnlyAssignments: string[];
  differingAssignments: string[];
  reportFingerprint: string;
}

export interface CodexConfigAdoptionResult {
  mode: CodexConfigAdoptionMode;
  productionConfig: string;
  shadowReport?: CodexShadowReport | undefined;
  shadowReportPath?: string | undefined;
}

export interface PrepareCodexConfigAdoptionOptions {
  repositoryRoot: string;
  environment: NodeJS.ProcessEnv;
  legacyConfig: string;
  bridgeBaseUrl: string;
  now?: Date | undefined;
  authority?: ResolvedConfigurationAuthority | undefined;
}

const EXPECTED_UNIFIED_ONLY_ASSIGNMENTS = [
  "approval_policy",
  "model_reasoning_summary",
  "sandbox_mode",
] as const;

export async function prepareCodexConfigAdoption(
  options: PrepareCodexConfigAdoptionOptions,
): Promise<CodexConfigAdoptionResult> {
  const repositoryRoot = resolve(options.repositoryRoot);
  const authority = options.authority ?? await resolveConfigurationAuthority({
    repositoryRoot,
    environment: options.environment,
  });
  const mode = authority.effective.runtime.adoption.codex.mode;

  if (mode === "legacy") {
    return { mode, productionConfig: options.legacyConfig };
  }

  const unifiedConfig = renderCodexConfig(
    authority.effective,
    options.bridgeBaseUrl,
  );
  const shadowReport = compareCodexShadowConfigs({
    legacyConfig: options.legacyConfig,
    unifiedConfig,
    effectiveFingerprint: authority.effectiveFingerprint,
    now: options.now,
  });
  const shadowReportPath = await writeCodexShadowReport(
    repositoryRoot,
    shadowReport,
  );

  // Phase 4.0E1 never changes the production config. The unified output is
  // rendered and compared only; Phase 4.0E2 owns the explicit cutover.
  return {
    mode,
    productionConfig: options.legacyConfig,
    shadowReport,
    shadowReportPath,
  };
}

export function compareCodexShadowConfigs(input: {
  legacyConfig: string;
  unifiedConfig: string;
  effectiveFingerprint: string;
  now?: Date | undefined;
}): CodexShadowReport {
  const legacy = parseTomlAssignments(input.legacyConfig);
  const unified = parseTomlAssignments(input.unifiedConfig);
  const expectedUnifiedOnly = new Set<string>(EXPECTED_UNIFIED_ONLY_ASSIGNMENTS);

  const shared = [...legacy.keys()].filter((path) => unified.has(path)).sort();
  const legacyOnlyAssignments = [...legacy.keys()]
    .filter((path) => !unified.has(path))
    .sort();
  const unifiedOnly = [...unified.keys()]
    .filter((path) => !legacy.has(path))
    .sort();
  const expectedUnifiedOnlyAssignments = unifiedOnly
    .filter((path) => expectedUnifiedOnly.has(path))
    .sort();
  const unexpectedUnifiedOnlyAssignments = unifiedOnly
    .filter((path) => !expectedUnifiedOnly.has(path))
    .sort();
  const missingExpectedUnifiedOnlyAssignments = [...expectedUnifiedOnly]
    .filter((path) => !unified.has(path))
    .sort();
  const differingAssignments = shared
    .filter((path) => legacy.get(path) !== unified.get(path))
    .sort();

  const status: CodexShadowReport["status"] = (
    legacyOnlyAssignments.length === 0
    && unexpectedUnifiedOnlyAssignments.length === 0
    && missingExpectedUnifiedOnlyAssignments.length === 0
    && differingAssignments.length === 0
  ) ? "compatible" : "drift";

  const reportWithoutFingerprint = {
    schemaVersion: 2 as const,
    phase: "4.0E1" as const,
    generatedAt: (input.now ?? new Date()).toISOString(),
    mode: "unified-shadow" as const,
    status,
    effectiveFingerprint: input.effectiveFingerprint,
    codexConfigFingerprint: fingerprintCodexConfigSemantics(input.unifiedConfig),
    legacyConfigSha256: sha256(normalizeNativeConfigText(input.legacyConfig)),
    unifiedConfigSha256: sha256(normalizeNativeConfigText(input.unifiedConfig)),
    sharedAssignments: shared.length,
    expectedUnifiedOnlyAssignments,
    missingExpectedUnifiedOnlyAssignments,
    unexpectedUnifiedOnlyAssignments,
    legacyOnlyAssignments,
    differingAssignments,
  };

  return {
    ...reportWithoutFingerprint,
    reportFingerprint: sha256(stableStringify({
      ...reportWithoutFingerprint,
      generatedAt: "<generated-at>",
    })),
  };
}

export function assessCodexShadowReport(
  report: CodexShadowReport,
  currentUnifiedConfig: string,
): "compatible" | "drift" {
  return report.status === "compatible"
    && report.codexConfigFingerprint === fingerprintCodexConfigSemantics(currentUnifiedConfig)
    ? "compatible"
    : "drift";
}

export function fingerprintCodexConfigSemantics(value: string): string {
  const assignments = [...parseTomlAssignments(value).entries()]
    .map(([path, assignment]) => [
      path,
      isDynamicBridgeBaseUrlAssignment(path)
        ? JSON.stringify(CODEX_BRIDGE_BASE_URL_PLACEHOLDER)
        : assignment,
    ] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return sha256(stableStringify(assignments));
}

function isDynamicBridgeBaseUrlAssignment(path: string): boolean {
  return /^model_providers\..+\.base_url$/u.test(path);
}

export async function writeCodexShadowReport(
  repositoryRoot: string,
  report: CodexShadowReport,
): Promise<string> {
  const path = join(resolve(repositoryRoot), "data/config/adoption/codex-shadow.json");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporary = `${path}.tmp-${String(process.pid)}-${Date.now().toString(36)}`;
  try {
    await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
  return path;
}

export async function readCodexShadowReport(
  repositoryRoot: string,
): Promise<CodexShadowReport | undefined> {
  const path = join(resolve(repositoryRoot), "data/config/adoption/codex-shadow.json");
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    // Schema 1 reports used the entire FLORAL effective fingerprint as their
    // freshness gate. Treat them as stale so a service restart can replace
    // them with the Codex-scoped schema 2 report.
    if (raw.schemaVersion === 1) return undefined;
    const parsed = raw as unknown as CodexShadowReport;
    if (
      parsed.schemaVersion !== 2
      || parsed.phase !== "4.0E1"
      || parsed.mode !== "unified-shadow"
      || !["compatible", "drift"].includes(parsed.status)
      || typeof parsed.reportFingerprint !== "string"
      || typeof parsed.codexConfigFingerprint !== "string"
      || !Array.isArray(parsed.expectedUnifiedOnlyAssignments)
      || !Array.isArray(parsed.missingExpectedUnifiedOnlyAssignments)
      || !Array.isArray(parsed.unexpectedUnifiedOnlyAssignments)
      || !Array.isArray(parsed.legacyOnlyAssignments)
      || !Array.isArray(parsed.differingAssignments)
    ) {
      throw new Error("Invalid Codex shadow report");
    }
    const { reportFingerprint, ...withoutFingerprint } = parsed;
    const expectedFingerprint = sha256(stableStringify({
      ...withoutFingerprint,
      generatedAt: "<generated-at>",
    }));
    if (reportFingerprint !== expectedFingerprint) {
      throw new Error("Invalid Codex shadow report fingerprint");
    }
    return parsed;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

export async function removeCodexShadowReport(
  repositoryRoot: string,
): Promise<void> {
  const path = join(resolve(repositoryRoot), "data/config/adoption/codex-shadow.json");
  await rm(path, { force: true });
}

export function renderCodexShadowReport(report: CodexShadowReport): string {
  return [
    `config.codex_shadow.schema_version=${String(report.schemaVersion)}`,
    `config.codex_shadow.phase=${report.phase}`,
    `config.codex_shadow.mode=${report.mode}`,
    `config.codex_shadow.status=${report.status}`,
    `config.codex_shadow.effective_fingerprint=${report.effectiveFingerprint}`,
    `config.codex_shadow.codex_config_fingerprint=${report.codexConfigFingerprint}`,
    `config.codex_shadow.legacy_sha256=${report.legacyConfigSha256}`,
    `config.codex_shadow.unified_sha256=${report.unifiedConfigSha256}`,
    `config.codex_shadow.shared_assignments=${String(report.sharedAssignments)}`,
    `config.codex_shadow.expected_additions=${report.expectedUnifiedOnlyAssignments.join(",") || "none"}`,
    `config.codex_shadow.missing_expected=${report.missingExpectedUnifiedOnlyAssignments.join(",") || "none"}`,
    `config.codex_shadow.unexpected_additions=${report.unexpectedUnifiedOnlyAssignments.join(",") || "none"}`,
    `config.codex_shadow.legacy_only=${report.legacyOnlyAssignments.join(",") || "none"}`,
    `config.codex_shadow.differences=${report.differingAssignments.join(",") || "none"}`,
    `config.codex_shadow.report_fingerprint=${report.reportFingerprint}`,
    "config.codex_shadow=ok",
    "",
  ].join("\n");
}

function parseTomlAssignments(value: string): Map<string, string> {
  const assignments = new Map<string, string>();
  let section = "";
  for (const rawLine of normalizeNativeConfigText(value).split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const sectionMatch = /^\[([^\]]+)\]$/u.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1]!.trim();
      continue;
    }
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error(`Unsupported Codex TOML line: ${line}`);
    const key = line.slice(0, separator).trim();
    const assignmentPath = section === "" ? key : `${section}.${key}`;
    if (assignments.has(assignmentPath)) {
      throw new Error(`Duplicate Codex TOML assignment: ${assignmentPath}`);
    }
    assignments.set(assignmentPath, line.slice(separator + 1).trim());
  }
  return assignments;
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
