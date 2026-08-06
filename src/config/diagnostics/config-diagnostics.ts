import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  assessCodexShadowReport,
  fingerprintCodexConfigSemantics,
  readCodexShadowReport,
  type CodexShadowReport,
} from "../adoption/codex-shadow-adoption.js";
import {
  CODEX_BRIDGE_BASE_URL_PLACEHOLDER,
  renderCodexConfig,
} from "../adapters/codex-native-config.js";
import {
  renderNativeConfigBundle,
} from "../adapters/native-config-bundle.js";
import {
  normalizeNativeConfigText,
  type NativeConfigArtifact,
  type NativeConfigBundle,
} from "../adapters/native-config-types.js";
import type {
  ConfigurationProvenance,
  ResolvedConfigurationAuthority,
} from "../federation/config-authority.js";
import { buildConfigurationInventory } from "../inventory/config-inventory.js";
import { assertLoopbackSearxngUrl } from "../../search/searxng.js";


export type DiagnosticLayer =
  | "requested"
  | "effective"
  | "rendered"
  | "installed"
  | "observed";

export type DiagnosticSeverity = "info" | "warning" | "error";

export interface ConfigDiagnosticFinding {
  code: string;
  component: "floral" | "codex" | "searxng" | "qq-sdk" | "mcp";
  layer: DiagnosticLayer;
  severity: DiagnosticSeverity;
  blocksCutover: boolean;
  message: string;
  path?: string | undefined;
  expected?: string | undefined;
  actual?: string | undefined;
}

export interface NativeInstallationArtifactObservation {
  relativePath: string;
  active: boolean;
  status: "match" | "drift" | "missing";
  expectedSha256: string;
  actualSha256?: string | undefined;
}

export interface NativeInstallationObservation {
  directory: string;
  manifestStatus: "match" | "drift" | "missing" | "invalid";
  expectedBundleFingerprint: string;
  installedBundleFingerprint?: string | undefined;
  artifacts: NativeInstallationArtifactObservation[];
}

export interface CodexInstallationObservation {
  path: string;
  status: "match" | "drift" | "missing" | "not-applicable";
  expectedSha256?: string | undefined;
  actualSha256?: string | undefined;
}

export interface SearxngInstallationObservation {
  composeStatus: "match" | "drift" | "missing";
  settingsStatus: "match" | "drift" | "missing";
}

export interface QqSdkInstallationObservation {
  expectedVersion: string;
  installedVersion?: string | undefined;
  status: "match" | "drift" | "unavailable";
  exportedSymbols: string[];
  configLikeSymbols: string[];
  declarationFileCount: number;
}

export interface SearxngRuntimeObservation {
  endpoint: string;
  status: "observed" | "unavailable" | "invalid" | "skipped";
  topLevelKeys: string[];
  engines: string[];
  plugins: string[];
  categories: string[];
  fingerprint?: string | undefined;
  errorType?: string | undefined;
}

export interface CodexRuntimeObservation {
  command: string;
  status: "compatible" | "unvalidated" | "unavailable" | "skipped";
  rawVersion?: string | undefined;
  normalizedVersion?: string | undefined;
}

export interface CodexShadowObservation {
  path: string;
  status: "compatible" | "drift" | "missing" | "invalid" | "disabled";
  reportFingerprint?: string | undefined;
  effectiveFingerprint?: string | undefined;
  codexConfigFingerprint?: string | undefined;
}

export interface ConfigurationCutoverGate {
  status: "ready" | "blocked";
  blockerCodes: string[];
  warningCodes: string[];
}

export interface ConfigurationDiagnosticsReport {
  schemaVersion: 1;
  generatedAt: string;
  authorityVersion: 1;
  profile: string;
  fingerprints: {
    requested: string;
    effective: string;
    rendered: string;
  };
  compatibility: {
    reviewedAt: string;
    fingerprint: string;
  };
  nativeInstallation: NativeInstallationObservation;
  productionInstallation: {
    codex: CodexInstallationObservation;
    searxng: SearxngInstallationObservation;
    qqSdk: QqSdkInstallationObservation;
  };
  runtime: {
    codex: CodexRuntimeObservation;
    searxng: SearxngRuntimeObservation;
  };
  adoption: {
    codexShadow: CodexShadowObservation;
  };
  findings: ConfigDiagnosticFinding[];
  cutoverGate: ConfigurationCutoverGate;
  reportFingerprint: string;
}

export interface RuntimeCompatibilityCatalog {
  schemaVersion: 1;
  reviewedAt: string;
  codex: {
    validatedVersions: string[];
    versionPrefix: string;
  };
  qqSdk: {
    package: string;
    validatedVersions: string[];
    requiredExports: string[];
    requiredMethods: string[];
  };
  searxng: {
    validatedImages: string[];
    configEndpoint: string;
  };
}

export interface BuildConfigurationDiagnosticsOptions {
  repositoryRoot: string;
  authority: ResolvedConfigurationAuthority;
  includeRuntimeProbes?: boolean | undefined;
  fetchImpl?: typeof fetch | undefined;
  now?: Date | undefined;
}

export async function buildConfigurationDiagnostics(
  options: BuildConfigurationDiagnosticsOptions,
): Promise<ConfigurationDiagnosticsReport> {
  const repositoryRoot = resolve(options.repositoryRoot);
  const bundle = renderNativeConfigBundle(options.authority);
  const compatibility = await loadRuntimeCompatibilityCatalog(repositoryRoot);
  const includeRuntimeProbes = options.includeRuntimeProbes ?? true;

  const [
    nativeInstallation,
    codexInstallation,
    searxngInstallation,
    inventory,
    searxngRuntime,
    codexShadow,
  ] = await Promise.all([
    observeNativeInstallation(repositoryRoot, bundle),
    observeCodexInstallation(repositoryRoot, options.authority, bundle),
    observeSearxngInstallation(repositoryRoot, bundle),
    buildConfigurationInventory({
      repositoryRoot,
      includeRuntimeProbes,
      codexCommand: options.authority.effective.codex.command,
      peekabooCommand: options.authority.effective.macos.peekaboo_command,
      now: options.now,
    }),
    includeRuntimeProbes
      ? observeSearxngRuntime(
          options.authority.effective.search.service_url,
          options.authority.effective.search.request_timeout_ms,
          compatibility.searxng.configEndpoint,
          options.fetchImpl,
        )
      : Promise.resolve(skippedSearxngRuntime(options.authority.effective.search.service_url)),
    observeCodexShadowAdoption(repositoryRoot, options.authority),
  ]);

  const qqSdk = observeQqSdkInstallation(options.authority, inventory.runtime.qqSdk);
  const codexRuntime = observeCodexRuntime(
    options.authority.effective.codex.command,
    inventory.runtime.codex.available,
    inventory.runtime.codex.version,
    compatibility,
    includeRuntimeProbes,
  );

  const findings = buildFindings({
    authority: options.authority,
    bundle,
    compatibility,
    nativeInstallation,
    codexInstallation,
    searxngInstallation,
    qqSdk,
    codexRuntime,
    searxngRuntime,
    codexShadow,
  });
  const blockerCodes = findings
    .filter((finding) => finding.blocksCutover)
    .map((finding) => finding.code)
    .sort();
  const warningCodes = findings
    .filter((finding) => finding.severity === "warning")
    .map((finding) => finding.code)
    .sort();

  const reportWithoutFingerprint = {
    schemaVersion: 1 as const,
    generatedAt: (options.now ?? new Date()).toISOString(),
    authorityVersion: options.authority.authorityVersion,
    profile: options.authority.effective.profile,
    fingerprints: {
      requested: options.authority.requestedFingerprint,
      effective: options.authority.effectiveFingerprint,
      rendered: bundle.bundleFingerprint,
    },
    compatibility: {
      reviewedAt: compatibility.reviewedAt,
      fingerprint: fingerprint(compatibility),
    },
    nativeInstallation,
    productionInstallation: {
      codex: codexInstallation,
      searxng: searxngInstallation,
      qqSdk,
    },
    runtime: {
      codex: codexRuntime,
      searxng: searxngRuntime,
    },
    adoption: {
      codexShadow,
    },
    findings: findings.sort(compareFindings),
    cutoverGate: {
      status: blockerCodes.length === 0 ? "ready" as const : "blocked" as const,
      blockerCodes,
      warningCodes,
    },
  };

  return {
    ...reportWithoutFingerprint,
    reportFingerprint: fingerprint({ ...reportWithoutFingerprint, generatedAt: "<generated-at>" }),
  };
}

export function renderConfigurationDiagnostics(report: ConfigurationDiagnosticsReport): string {
  const lines = [
    `config.diagnostics.schema_version=${String(report.schemaVersion)}`,
    `config.diagnostics.profile=${sanitizeLine(report.profile)}`,
    `config.diagnostics.requested_fingerprint=${report.fingerprints.requested}`,
    `config.diagnostics.effective_fingerprint=${report.fingerprints.effective}`,
    `config.diagnostics.rendered_fingerprint=${report.fingerprints.rendered}`,
    `config.diagnostics.report_fingerprint=${report.reportFingerprint}`,
    `config.diagnostics.compatibility_reviewed_at=${report.compatibility.reviewedAt}`,
    `config.diagnostics.compatibility_fingerprint=${report.compatibility.fingerprint}`,
    `config.diagnostics.native_manifest=${report.nativeInstallation.manifestStatus}`,
    `config.diagnostics.codex_installed=${report.productionInstallation.codex.status}`,
    `config.diagnostics.searxng_compose=${report.productionInstallation.searxng.composeStatus}`,
    `config.diagnostics.searxng_settings=${report.productionInstallation.searxng.settingsStatus}`,
    `config.diagnostics.qq_sdk=${report.productionInstallation.qqSdk.status}`,
    `config.diagnostics.codex_runtime=${report.runtime.codex.status}`,
    `config.diagnostics.codex_version=${report.runtime.codex.normalizedVersion ?? "unavailable"}`,
    `config.diagnostics.searxng_runtime=${report.runtime.searxng.status}`,
    `config.diagnostics.searxng_engines=${String(report.runtime.searxng.engines.length)}`,
    `config.diagnostics.searxng_plugins=${String(report.runtime.searxng.plugins.length)}`,
    `config.diagnostics.codex_shadow=${report.adoption.codexShadow.status}`,
    `config.diagnostics.codex_shadow_config_fingerprint=${report.adoption.codexShadow.codexConfigFingerprint ?? "unavailable"}`,
    `config.diagnostics.findings=${String(report.findings.length)}`,
    `config.cutover.status=${report.cutoverGate.status}`,
    `config.cutover.blockers=${String(report.cutoverGate.blockerCodes.length)}`,
    `config.cutover.warnings=${String(report.cutoverGate.warningCodes.length)}`,
  ];
  for (const finding of report.findings) {
    lines.push(
      `config.diagnostics.finding.${finding.severity}=${finding.code}:${sanitizeLine(finding.message)}`,
    );
  }
  lines.push("config.diagnostics=ok");
  return `${lines.join("\n")}\n`;
}

export function explainConfigurationPath(
  authority: ResolvedConfigurationAuthority,
  bundle: NativeConfigBundle,
  path: string,
): Record<string, unknown> {
  const requested = getAtPath(authority.requested as unknown as Record<string, unknown>, path);
  const effective = getAtPath(authority.effective as unknown as Record<string, unknown>, path);
  if (requested === undefined && effective === undefined) {
    throw new Error(`Unknown configuration path: ${path}`);
  }
  const provenance = authority.provenance[path];
  return {
    path,
    requested,
    effective,
    provenance: provenance ?? defaultProvenance(authority, path),
    renderedArtifacts: inferRenderedArtifacts(path, bundle),
  };
}

export function renderConfigurationExplanation(explanation: Record<string, unknown>): string {
  const provenance = explanation.provenance as ConfigurationProvenance;
  const artifacts = explanation.renderedArtifacts as string[];
  return [
    `config.explain.path=${String(explanation.path)}`,
    `config.explain.requested=${safeInline(explanation.requested)}`,
    `config.explain.effective=${safeInline(explanation.effective)}`,
    `config.explain.source=${provenance.source}`,
    `config.explain.source_key=${provenance.sourceKey ?? "none"}`,
    `config.explain.classification=${provenance.classification ?? "unclassified"}`,
    `config.explain.locked=${String(provenance.locked)}`,
    `config.explain.rendered_artifacts=${artifacts.join(",") || "none"}`,
    "config.explain=ok",
    "",
  ].join("\n");
}

export function diagnosticsHasStructuralErrors(report: ConfigurationDiagnosticsReport): boolean {
  return report.findings.some((finding) => (
    finding.severity === "error" && finding.layer !== "observed"
  ));
}

export function cutoverIsReady(report: ConfigurationDiagnosticsReport): boolean {
  return report.cutoverGate.status === "ready";
}

export function safeConfigurationDiagnosticsJson(
  report: ConfigurationDiagnosticsReport,
): Record<string, unknown> {
  return JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
}

export async function loadRuntimeCompatibilityCatalog(
  repositoryRoot: string,
): Promise<RuntimeCompatibilityCatalog> {
  const path = join(repositoryRoot, "config/catalog/runtime-compatibility.json");
  const parsed = JSON.parse(await readFile(path, "utf8")) as RuntimeCompatibilityCatalog;
  if (parsed.schemaVersion !== 1) {
    throw new Error(`Unsupported runtime compatibility schema: ${String(parsed.schemaVersion)}`);
  }
  if (parsed.codex.validatedVersions.length === 0 || parsed.qqSdk.validatedVersions.length === 0) {
    throw new Error("Runtime compatibility catalog must validate at least one Codex and QQ SDK version");
  }
  return parsed;
}

async function observeNativeInstallation(
  repositoryRoot: string,
  bundle: NativeConfigBundle,
): Promise<NativeInstallationObservation> {
  const directory = join(repositoryRoot, "data/config/native");
  const manifestPath = join(directory, "manifest.json");
  let manifestStatus: NativeInstallationObservation["manifestStatus"] = "missing";
  let installedBundleFingerprint: string | undefined;
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      bundleFingerprint?: unknown;
    };
    installedBundleFingerprint = typeof manifest.bundleFingerprint === "string"
      ? manifest.bundleFingerprint
      : undefined;
    manifestStatus = installedBundleFingerprint === bundle.bundleFingerprint ? "match" : "drift";
  } catch (error) {
    if (!isMissing(error)) manifestStatus = "invalid";
  }

  const artifacts = await Promise.all(bundle.artifacts.map(async (artifact) => {
    try {
      const actual = normalizeNativeConfigText(await readFile(join(directory, artifact.relativePath), "utf8"));
      const actualSha256 = fingerprintText(actual);
      return {
        relativePath: artifact.relativePath,
        active: artifact.active,
        status: actualSha256 === artifact.sha256 ? "match" as const : "drift" as const,
        expectedSha256: artifact.sha256,
        actualSha256,
      };
    } catch (error) {
      if (!isMissing(error)) throw error;
      return {
        relativePath: artifact.relativePath,
        active: artifact.active,
        status: "missing" as const,
        expectedSha256: artifact.sha256,
      };
    }
  }));

  return {
    directory,
    manifestStatus,
    expectedBundleFingerprint: bundle.bundleFingerprint,
    ...(installedBundleFingerprint ? { installedBundleFingerprint } : {}),
    artifacts,
  };
}

async function observeCodexInstallation(
  repositoryRoot: string,
  authority: ResolvedConfigurationAuthority,
  bundle: NativeConfigBundle,
): Promise<CodexInstallationObservation> {
  const managedHome = resolveRepositoryPath(repositoryRoot, authority.effective.codex.managed_home);
  const path = join(managedHome, "config.toml");
  if (authority.effective.codex.mode !== "real") {
    return { path, status: "not-applicable" };
  }
  const expectedArtifact = requireArtifact(bundle, "codex/config.toml");
  const expected = normalizeCodexInstalledConfig(expectedArtifact.content);
  try {
    const actual = normalizeCodexInstalledConfig(await readFile(path, "utf8"));
    const expectedSha256 = fingerprintText(expected);
    const actualSha256 = fingerprintText(actual);
    return {
      path,
      status: expected === actual ? "match" : "drift",
      expectedSha256,
      actualSha256,
    };
  } catch (error) {
    if (!isMissing(error)) throw error;
    return {
      path,
      status: "missing",
      expectedSha256: fingerprintText(expected),
    };
  }
}

async function observeSearxngInstallation(
  repositoryRoot: string,
  bundle: NativeConfigBundle,
): Promise<SearxngInstallationObservation> {
  return {
    composeStatus: await compareFile(
      join(repositoryRoot, "infra/searxng/compose.yaml"),
      requireArtifact(bundle, "searxng/compose.yaml").content,
    ),
    settingsStatus: await compareFile(
      join(repositoryRoot, "infra/searxng/settings.template.yml"),
      requireArtifact(bundle, "searxng/settings.yml").content,
    ),
  };
}

function observeQqSdkInstallation(
  authority: ResolvedConfigurationAuthority,
  observation: Awaited<ReturnType<typeof buildConfigurationInventory>>["runtime"]["qqSdk"],
): QqSdkInstallationObservation {
  const expectedVersion = authority.effective.qq.sdk.expected_version;
  const installedVersion = observation.packageVersion;
  return {
    expectedVersion,
    ...(installedVersion ? { installedVersion } : {}),
    status: installedVersion
      ? installedVersion === expectedVersion ? "match" : "drift"
      : "unavailable",
    exportedSymbols: observation.exportedSymbols,
    configLikeSymbols: observation.configLikeSymbols,
    declarationFileCount: observation.declarationFileCount,
  };
}

function observeCodexRuntime(
  command: string,
  available: boolean,
  rawVersion: string | undefined,
  compatibility: RuntimeCompatibilityCatalog,
  includeRuntimeProbes: boolean,
): CodexRuntimeObservation {
  if (!includeRuntimeProbes) return { command, status: "skipped" };
  if (!available || !rawVersion) return { command, status: "unavailable" };
  const normalizedVersion = normalizeCodexVersion(rawVersion, compatibility.codex.versionPrefix);
  return {
    command,
    rawVersion,
    ...(normalizedVersion ? { normalizedVersion } : {}),
    status: normalizedVersion && compatibility.codex.validatedVersions.includes(normalizedVersion)
      ? "compatible"
      : "unvalidated",
  };
}

async function observeSearxngRuntime(
  baseUrl: string,
  timeoutMs: number,
  endpointPath: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SearxngRuntimeObservation> {
  const base = assertLoopbackSearxngUrl(baseUrl);
  const endpoint = new URL(endpointPath, ensureTrailingSlash(base));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(endpoint, {
      method: "GET",
      headers: {
        accept: "application/json",
        "user-agent": "FLORAL-Config-Diagnostics/0.1",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      return emptySearxngRuntime(endpoint.toString(), "invalid", `HTTP_${String(response.status)}`);
    }
    const body = await response.json() as unknown;
    if (!isRecord(body)) return emptySearxngRuntime(endpoint.toString(), "invalid", "InvalidJsonShape");
    const engines = extractNamedEntries(body.engines);
    const plugins = extractNamedEntries(body.plugins);
    const categories = extractNamedEntries(body.categories);
    const safe = {
      topLevelKeys: Object.keys(body).sort(),
      engines,
      plugins,
      categories,
    };
    return {
      endpoint: endpoint.toString(),
      status: "observed",
      ...safe,
      fingerprint: fingerprint(safe),
    };
  } catch (error) {
    return emptySearxngRuntime(
      endpoint.toString(),
      "unavailable",
      controller.signal.aborted ? "Timeout" : safeErrorType(error),
    );
  } finally {
    clearTimeout(timer);
  }
}

function buildFindings(input: {
  authority: ResolvedConfigurationAuthority;
  bundle: NativeConfigBundle;
  compatibility: RuntimeCompatibilityCatalog;
  nativeInstallation: NativeInstallationObservation;
  codexInstallation: CodexInstallationObservation;
  searxngInstallation: SearxngInstallationObservation;
  qqSdk: QqSdkInstallationObservation;
  codexRuntime: CodexRuntimeObservation;
  searxngRuntime: SearxngRuntimeObservation;
  codexShadow: CodexShadowObservation;
}): ConfigDiagnosticFinding[] {
  const findings: ConfigDiagnosticFinding[] = [];
  if (input.nativeInstallation.manifestStatus !== "match") {
    findings.push(finding(
      "native-bundle-not-installed",
      "floral",
      "installed",
      "warning",
      true,
      `Rendered native bundle is ${input.nativeInstallation.manifestStatus}; run config:native:write`,
    ));
  }
  for (const artifact of input.nativeInstallation.artifacts) {
    if (artifact.active && artifact.status !== "match") {
      findings.push(finding(
        `native-artifact-${slug(artifact.relativePath)}-${artifact.status}`,
        componentForArtifact(artifact.relativePath),
        "installed",
        "warning",
        true,
        `Active native artifact ${artifact.relativePath} is ${artifact.status}`,
        artifact.relativePath,
        artifact.expectedSha256,
        artifact.actualSha256,
      ));
    }
  }

  if (
    input.authority.effective.codex.mode === "real"
    && input.authority.effective.runtime.adoption.codex.mode === "unified-shadow"
  ) {
    if (input.codexShadow.status === "missing") {
      findings.push(finding(
        "codex-shadow-report-missing",
        "codex",
        "observed",
        "warning",
        true,
        "Codex unified-shadow mode is enabled but no runtime comparison report exists; restart the FLORAL service",
        input.codexShadow.path,
      ));
    } else if (input.codexShadow.status !== "compatible") {
      findings.push(finding(
        `codex-shadow-${input.codexShadow.status}`,
        "codex",
        "observed",
        "warning",
        true,
        "Codex legacy and unified configurations are not shadow-compatible for the current effective configuration",
        input.codexShadow.path,
        fingerprintCodexConfigSemantics(renderCodexConfig(input.authority.effective)),
        input.codexShadow.codexConfigFingerprint,
      ));
    }
  }

  if (input.codexInstallation.status === "drift") {
    findings.push(finding(
      "codex-managed-config-legacy-drift",
      "codex",
      "installed",
      "warning",
      true,
      "Managed Codex config.toml does not match the unified renderer; production still uses the legacy generator",
      input.codexInstallation.path,
      input.codexInstallation.expectedSha256,
      input.codexInstallation.actualSha256,
    ));
  } else if (input.codexInstallation.status === "missing" && input.authority.effective.codex.mode === "real") {
    findings.push(finding(
      "codex-managed-config-missing",
      "codex",
      "installed",
      "warning",
      true,
      "Managed Codex config.toml is not currently installed",
      input.codexInstallation.path,
    ));
  }
  if (input.searxngInstallation.composeStatus !== "match") {
    findings.push(finding(
      "searxng-compose-drift",
      "searxng",
      "installed",
      "error",
      true,
      `Checked-in SearXNG compose configuration is ${input.searxngInstallation.composeStatus}`,
    ));
  }
  if (input.searxngInstallation.settingsStatus !== "match") {
    findings.push(finding(
      "searxng-settings-drift",
      "searxng",
      "installed",
      "error",
      true,
      `Checked-in SearXNG settings configuration is ${input.searxngInstallation.settingsStatus}`,
    ));
  }
  if (!input.compatibility.searxng.validatedImages.includes(input.authority.effective.search.container.image)) {
    findings.push(finding(
      "searxng-image-unvalidated",
      "searxng",
      "effective",
      "error",
      true,
      "Configured SearXNG image is not in the reviewed runtime compatibility catalog",
      "search.container.image",
      input.compatibility.searxng.validatedImages.join(","),
      input.authority.effective.search.container.image,
    ));
  }
  if (input.qqSdk.status !== "match" && input.authority.effective.qq.mode === "real") {
    findings.push(finding(
      "qq-sdk-version-drift",
      "qq-sdk",
      "observed",
      "error",
      true,
      "Installed QQ SDK version is unavailable or differs from the effective configuration",
      "qq.sdk.expected_version",
      input.qqSdk.expectedVersion,
      input.qqSdk.installedVersion,
    ));
  }
  if (input.qqSdk.status === "match" && input.qqSdk.declarationFileCount === 0) {
    findings.push(finding(
      "qq-sdk-declaration-surface-unavailable",
      "qq-sdk",
      "observed",
      "warning",
      false,
      "QQ SDK package version matches, but no declaration files were observed; runtime ABI checks remain authoritative",
    ));
  }
  if (input.codexRuntime.status !== "compatible" && input.authority.effective.codex.mode === "real") {
    findings.push(finding(
      input.codexRuntime.status === "unavailable" ? "codex-runtime-unavailable" : "codex-version-unvalidated",
      "codex",
      "observed",
      "error",
      true,
      input.codexRuntime.status === "unavailable"
        ? "Codex executable was not available for runtime compatibility observation"
        : "Observed Codex version is not in the reviewed compatibility catalog",
      "codex.command",
      input.compatibility.codex.validatedVersions.join(","),
      input.codexRuntime.normalizedVersion,
    ));
  }
  if (input.searxngRuntime.status !== "observed" && input.authority.effective.mcp.search.enabled) {
    findings.push(finding(
      "searxng-effective-config-unobserved",
      "searxng",
      "observed",
      "warning",
      true,
      "SearXNG /config could not be observed, so inherited engines and plugins are not frozen",
      input.searxngRuntime.endpoint,
      undefined,
      input.searxngRuntime.errorType,
    ));
  } else if (
    input.searxngRuntime.status === "observed"
    && input.authority.effective.search.settings.use_default_settings
    && input.searxngRuntime.engines.length === 0
  ) {
    findings.push(finding(
      "searxng-effective-engines-empty",
      "searxng",
      "observed",
      "warning",
      true,
      "SearXNG inherits upstream defaults but the observed /config response exposed no engine names",
    ));
  }
  if (input.bundle.artifacts.some((artifact) => !artifact.active)) {
    findings.push(finding(
      "preview-artifacts-not-adopted",
      "floral",
      "rendered",
      "info",
      false,
      "Preview-only artifacts remain intentionally uninstalled until a controlled production adoption phase",
    ));
  }
  return findings;
}

async function observeCodexShadowAdoption(
  repositoryRoot: string,
  authority: ResolvedConfigurationAuthority,
): Promise<CodexShadowObservation> {
  const path = join(repositoryRoot, "data/config/adoption/codex-shadow.json");
  if (authority.effective.runtime.adoption.codex.mode === "legacy") {
    return { path, status: "disabled" };
  }
  try {
    const report: CodexShadowReport | undefined = await readCodexShadowReport(repositoryRoot);
    if (!report) return { path, status: "missing" };
    const currentUnifiedConfig = renderCodexConfig(authority.effective);
    const currentCodexConfigFingerprint = fingerprintCodexConfigSemantics(currentUnifiedConfig);
    const status = assessCodexShadowReport(report, currentUnifiedConfig);
    return {
      path,
      status,
      reportFingerprint: report.reportFingerprint,
      effectiveFingerprint: report.effectiveFingerprint,
      codexConfigFingerprint: report.codexConfigFingerprint,
    };
  } catch {
    return { path, status: "invalid" };
  }
}

function normalizeCodexInstalledConfig(value: string): string {
  const normalized = normalizeNativeConfigText(value)
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .map((line) => line.replace(
      /^base_url\s*=\s*.+$/u,
      `base_url = ${JSON.stringify(CODEX_BRIDGE_BASE_URL_PLACEHOLDER)}`,
    ))
    .filter((line, index, lines) => line !== "" || (index > 0 && lines[index - 1] !== ""))
    .join("\n")
    .trim();
  return `${normalized}\n`;
}

async function compareFile(
  path: string,
  expected: string,
): Promise<"match" | "drift" | "missing"> {
  try {
    const actual = await readFile(path, "utf8");
    return normalizeNativeConfigText(actual) === normalizeNativeConfigText(expected)
      ? "match"
      : "drift";
  } catch (error) {
    if (isMissing(error)) return "missing";
    throw error;
  }
}

function normalizeCodexVersion(raw: string, prefix: string): string | undefined {
  const firstLine = raw.trim().split(/\r?\n/u)[0]?.trim();
  if (!firstLine) return undefined;
  if (firstLine.startsWith(prefix)) return firstLine.slice(prefix.length).trim();
  return firstLine.match(/\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?/u)?.[0];
}

function skippedSearxngRuntime(baseUrl: string): SearxngRuntimeObservation {
  return {
    endpoint: baseUrl,
    status: "skipped",
    topLevelKeys: [],
    engines: [],
    plugins: [],
    categories: [],
  };
}

function emptySearxngRuntime(
  endpoint: string,
  status: "unavailable" | "invalid",
  errorType: string,
): SearxngRuntimeObservation {
  return {
    endpoint,
    status,
    topLevelKeys: [],
    engines: [],
    plugins: [],
    categories: [],
    errorType,
  };
}

function extractNamedEntries(value: unknown): string[] {
  if (isRecord(value)) return Object.keys(value).sort().slice(0, 300);
  if (!Array.isArray(value)) return [];
  const names = new Set<string>();
  for (const item of value) {
    if (typeof item === "string" && item.trim() !== "") names.add(item.trim());
    else if (isRecord(item)) {
      for (const key of ["name", "id", "engine", "category"]) {
        const candidate = item[key];
        if (typeof candidate === "string" && candidate.trim() !== "") {
          names.add(candidate.trim());
          break;
        }
      }
    }
  }
  return [...names].sort().slice(0, 300);
}

function inferRenderedArtifacts(path: string, bundle: NativeConfigBundle): string[] {
  const component = path.split(".")[0];
  const componentsByPath: Record<string, NativeConfigArtifact["component"][]> = {
    codex: ["codex", "mcp"],
    deepseek: ["codex"],
    bridge: ["codex"],
    search: ["searxng", "mcp", "codex"],
    qq: ["qq-sdk"],
    mcp: ["mcp", "codex"],
  };
  const components = componentsByPath[component ?? ""] ?? [];
  return bundle.artifacts
    .filter((artifact) => components.includes(artifact.component))
    .map((artifact) => artifact.relativePath)
    .sort();
}

function defaultProvenance(
  authority: ResolvedConfigurationAuthority,
  path: string,
): ConfigurationProvenance {
  return {
    source: "default",
    locked: authority.lockedPaths.includes(path),
  };
}

function resolveRepositoryPath(repositoryRoot: string, path: string): string {
  return isAbsolute(path) ? path : resolve(repositoryRoot, path);
}

function requireArtifact(bundle: NativeConfigBundle, relativePath: string): NativeConfigArtifact {
  const artifact = bundle.artifacts.find((entry) => entry.relativePath === relativePath);
  if (!artifact) throw new Error(`Native artifact missing: ${relativePath}`);
  return artifact;
}

function componentForArtifact(relativePath: string): ConfigDiagnosticFinding["component"] {
  if (relativePath.startsWith("codex/")) return "codex";
  if (relativePath.startsWith("searxng/")) return "searxng";
  if (relativePath.startsWith("qq/")) return "qq-sdk";
  if (relativePath.startsWith("mcp/")) return "mcp";
  return "floral";
}

function finding(
  code: string,
  component: ConfigDiagnosticFinding["component"],
  layer: DiagnosticLayer,
  severity: DiagnosticSeverity,
  blocksCutover: boolean,
  message: string,
  path?: string,
  expected?: string,
  actual?: string,
): ConfigDiagnosticFinding {
  return {
    code,
    component,
    layer,
    severity,
    blocksCutover,
    message,
    ...(path ? { path } : {}),
    ...(expected ? { expected } : {}),
    ...(actual ? { actual } : {}),
  };
}

function compareFindings(left: ConfigDiagnosticFinding, right: ConfigDiagnosticFinding): number {
  return `${left.severity}:${left.component}:${left.code}`.localeCompare(
    `${right.severity}:${right.component}:${right.code}`,
  );
}

function getAtPath(root: Record<string, unknown>, path: string): unknown {
  let current: unknown = root;
  for (const segment of path.split(".")) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function safeInline(value: unknown): string {
  if (typeof value === "string") return sanitizeLine(value);
  const serialized = JSON.stringify(value);
  return serialized === undefined ? "undefined" : sanitizeLine(serialized);
}

function sanitizeLine(value: string): string {
  return value.replace(/[\r\n]+/gu, " ").slice(0, 500);
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
}

function ensureTrailingSlash(url: URL): URL {
  const copy = new URL(url);
  if (!copy.pathname.endsWith("/")) copy.pathname += "/";
  copy.search = "";
  copy.hash = "";
  return copy;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function fingerprintText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function safeErrorType(error: unknown): string {
  if (error instanceof Error) {
    if ("code" in error && typeof (error as NodeJS.ErrnoException).code === "string") {
      return (error as NodeJS.ErrnoException).code ?? error.name;
    }
    return error.name;
  }
  return typeof error;
}
