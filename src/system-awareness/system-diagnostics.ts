import {
  validateSystemReadModel,
  type SystemReadModel,
} from "./system-read-interface.js";
import type {
  SystemComponentSnapshot,
  SystemDefinition,
  SystemEvidenceConfidence,
  SystemEvidenceValue,
  SystemFactResolution,
  SystemFactSnapshot,
  SystemFailureDomain,
} from "./system-types.js";

export const SYSTEM_DIAGNOSTICS_SCHEMA_VERSION = 1 as const;

export type SystemDiagnosticSeverity = "info" | "warning" | "error";
export type SystemDiagnosticStatus =
  | "healthy"
  | "inactive"
  | "degraded"
  | "unavailable"
  | "unknown"
  | "conflict";
export type SystemDiagnosticImpact = "none" | "degraded" | "unavailable" | "conflict";
export type SystemDiagnosticConfidence = "high" | "medium" | "low" | "unknown";

export interface SystemDiagnosticEvidenceRef {
  componentId: string;
  fact: string;
  resolution: SystemFactResolution;
  confidence: SystemEvidenceConfidence;
  sources: readonly string[];
}

export interface SystemDiagnosticCheck {
  order: number;
  id: string;
  description: string;
  interface: string;
  readOnly: true;
}

export interface SystemDiagnosticFinding {
  id: string;
  componentId?: string | undefined;
  subjectId?: string | undefined;
  severity: SystemDiagnosticSeverity;
  status: SystemDiagnosticStatus;
  impact: SystemDiagnosticImpact;
  confidence: SystemDiagnosticConfidence;
  summary: string;
  candidateFailureDomains: readonly SystemFailureDomain[];
  evidence: readonly SystemDiagnosticEvidenceRef[];
  checks: readonly SystemDiagnosticCheck[];
  limitations: readonly string[];
}

export interface SystemDiagnosticReport {
  schemaVersion: typeof SYSTEM_DIAGNOSTICS_SCHEMA_VERSION;
  generatedAt: string;
  snapshotGeneratedAt: string;
  definitionFingerprint: string;
  scope: string;
  overallStatus: "healthy" | "degraded" | "unavailable" | "conflict";
  findings: readonly SystemDiagnosticFinding[];
  executionPerformed: false;
  maintenanceEnabled: boolean;
}

const MAX_DIAGNOSTIC_LENGTH = 16_000;
const MAX_SUMMARY_LENGTH = 600;

export function buildSystemDiagnosticReport(
  model: SystemReadModel,
  componentId?: string | undefined,
): SystemDiagnosticReport {
  const registry = validateSystemReadModel(model);
  const normalized = componentId?.trim();
  if (normalized && !registry.has(normalized)) {
    throw new Error(`Unknown system component id: ${normalized}`);
  }

  const targetDefinitions = normalized
    ? [registry.require(normalized)]
    : registry.list();
  const findings: SystemDiagnosticFinding[] = [];

  if (!normalized) appendObserverFailures(model, findings);
  appendConflicts(model, targetDefinitions, findings);

  for (const definition of targetDefinitions) {
    if (definition.id === "floral.service") diagnoseService(model, definition, findings);
    if (definition.id === "floral.maintenance") diagnoseMaintenance(model, definition, findings);
    if (definition.id === "codex.apps") diagnoseApps(model, definition, findings);
    if (definition.id === "extensions.external_mcp") {
      diagnoseExternalMcp(model, definition, findings);
    }
    if (definition.id.startsWith("mcp.floral_")) {
      diagnoseBuiltinMcp(model, definition, findings);
    }
    if (definition.id === "deepseek.provider") {
      diagnoseProviderCredential(model, definition, findings);
    }
    if (definition.id === "transport.feishu") {
      diagnoseFeishuTransport(model, definition, findings);
    }
  }

  const ordered = findings
    .filter((finding, index, all) => all.findIndex((item) => item.id === finding.id) === index)
    .sort(compareFindings);

  return {
    schemaVersion: SYSTEM_DIAGNOSTICS_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    snapshotGeneratedAt: model.snapshot.generatedAt,
    definitionFingerprint: model.snapshot.definitionFingerprint,
    scope: normalized ?? "all",
    overallStatus: overallStatus(ordered),
    findings: ordered,
    executionPerformed: false,
    maintenanceEnabled: registry.has("floral.maintenance")
      && Boolean(model.snapshot.components.find((component) => component.componentId === "floral.maintenance")?.observed)
      && registry.require("floral.service").managementActions.some((action) => action.id === "restart"),
  };
}

export function formatSystemDiagnostics(
  model: SystemReadModel,
  componentId?: string | undefined,
): string {
  const report = buildSystemDiagnosticReport(model, componentId);
  const errors = report.findings.filter((finding) => finding.severity === "error").length;
  const warnings = report.findings.filter((finding) => finding.severity === "warning").length;
  const infos = report.findings.filter((finding) => finding.severity === "info").length;
  const lines = [
    "FLORAL Self-Diagnostics",
    `diagnostics_schema_version=${String(report.schemaVersion)}`,
    `snapshot_generated_at=${report.snapshotGeneratedAt}`,
    `diagnostics_generated_at=${report.generatedAt}`,
    `definition_fingerprint=${report.definitionFingerprint}`,
    `scope=${report.scope}`,
    `overall=${report.overallStatus}`,
    `findings=${String(report.findings.length)}`,
    `errors=${String(errors)} warnings=${String(warnings)} info=${String(infos)}`,
    "execution_performed=false",
    `maintenance_enabled=${String(report.maintenanceEnabled)}`,
    "governed_maintenance_interface=floral_system/maintain",
  ];

  if (report.findings.length === 0) {
    lines.push("diagnosis=healthy-no-evidence-backed-problem-detected");
  }

  for (const finding of report.findings) {
    lines.push([
      `finding=${finding.id}`,
      `component=${finding.componentId ?? "none"}`,
      `subject=${finding.subjectId ?? "none"}`,
      `severity=${finding.severity}`,
      `status=${finding.status}`,
      `impact=${finding.impact}`,
      `confidence=${finding.confidence}`,
      `failure_domains=${JSON.stringify(finding.candidateFailureDomains)}`,
      `summary=${JSON.stringify(finding.summary.slice(0, MAX_SUMMARY_LENGTH))}`,
    ].join(" "));
    for (const evidence of finding.evidence) {
      lines.push([
        `evidence_ref=${evidence.componentId}/${evidence.fact}`,
        `resolution=${evidence.resolution}`,
        `confidence=${evidence.confidence}`,
        `sources=${JSON.stringify(evidence.sources)}`,
      ].join(" "));
    }
    for (const check of finding.checks) {
      lines.push([
        `check=${String(check.order)}`,
        `id=${check.id}`,
        `interface=${safeToken(check.interface)}`,
        `read_only=true`,
        `description=${JSON.stringify(check.description)}`,
      ].join(" "));
    }
    for (const limitation of finding.limitations) {
      lines.push(`limitation=${JSON.stringify(limitation)}`);
    }
  }

  lines.push(
    "diagnostic_semantics=derived-findings-are-not-authoritative-state-evidence",
    "causality_semantics=candidate-failure-domains-are-ranked-hypotheses-not-proven-root-cause",
    "unknown_semantics=absence-of-evidence-must-not-be-upgraded-by-guessing",
    "recommendation_semantics=checks-are-read-only-plans-and-are-not-executed-by-this-interface",
    "management_semantics=use-floral_system-capabilities-separately-before-discussing-any-governed-repair-action",
  );
  return boundedText(lines.join("\n"), MAX_DIAGNOSTIC_LENGTH);
}

function appendObserverFailures(
  model: SystemReadModel,
  findings: SystemDiagnosticFinding[],
): void {
  for (const observer of model.snapshot.observers) {
    if (observer.status !== "failed") continue;
    findings.push({
      id: `observer.${safeToken(observer.observerId)}.failed`,
      severity: "warning",
      status: "degraded",
      impact: "degraded",
      confidence: "high",
      summary: `System observer ${observer.observerId} failed, so dependent state may be incomplete.`,
      candidateFailureDomains: ["floral"],
      evidence: [],
      checks: [check(
        1,
        "refresh-snapshot-next-turn",
        "Request a fresh System Awareness snapshot on the next turn and confirm whether the observer still fails.",
        "floral_system/system_summary",
      )],
      limitations: [
        `Only the bounded observer error type is available: ${observer.errorType ?? "unknown"}.`,
      ],
    });
  }
}

function appendConflicts(
  model: SystemReadModel,
  definitions: readonly SystemDefinition[],
  findings: SystemDiagnosticFinding[],
): void {
  for (const definition of definitions) {
    const component = componentSnapshot(model, definition.id);
    for (const fact of component?.facts ?? []) {
      if (fact.resolution !== "conflict") continue;
      findings.push({
        id: `${definition.id}.${fact.fact}.evidence-conflict`,
        componentId: definition.id,
        severity: "error",
        status: "conflict",
        impact: "conflict",
        confidence: "high",
        summary: `Equally strong evidence disagrees for ${definition.id}/${fact.fact}; FLORAL cannot safely choose a value.`,
        candidateFailureDomains: [definition.failureDomain],
        evidence: [evidenceRef(definition.id, fact)],
        checks: [
          check(
            1,
            "inspect-conflicting-evidence",
            `Read ${definition.id} and compare the conflicting authoritative/observed sources without changing state.`,
            "floral_system/component_status",
          ),
          check(
            2,
            "refresh-next-turn",
            "Capture a fresh snapshot on the next turn to determine whether the conflict persists.",
            "floral_system/component_status",
          ),
        ],
        limitations: ["A conflict is intentionally not auto-resolved by source-name heuristics."],
      });
    }
  }
}

function diagnoseService(
  model: SystemReadModel,
  definition: SystemDefinition,
  findings: SystemDiagnosticFinding[],
): void {
  const phase = factSnapshot(model, definition.id, "recorded.phase");
  const alive = factSnapshot(model, definition.id, "process.alive");
  if (resolvedString(phase) === "ready" && resolvedBoolean(alive) === false) {
    findings.push({
      id: "floral.service.ready-but-process-dead",
      componentId: definition.id,
      severity: "error",
      status: "unavailable",
      impact: "unavailable",
      confidence: "high",
      summary: "The service-state record says ready, but the recorded process is not alive; the persisted service record is stale or the service exited after writing ready.",
      candidateFailureDomains: ["host", "floral"],
      evidence: compactEvidenceRefs([
        evidenceRefIf(definition.id, phase),
        evidenceRefIf(definition.id, alive),
      ]),
      checks: [
        check(1, "owner-status", "Confirm the current service/process view with the owner-facing diagnostic status command.", "/status --debug"),
        check(2, "service-logs", "Inspect FLORAL service logs read-only for the exit or crash boundary.", "service:logs"),
      ],
      limitations: ["This diagnosis does not restart the service or mutate LaunchAgent state."],
    });
    return;
  }

  if (resolvedString(phase) === "failed") {
    findings.push({
      id: "floral.service.recorded-failed",
      componentId: definition.id,
      severity: "error",
      status: "unavailable",
      impact: "unavailable",
      confidence: "high",
      summary: "The FLORAL service lifecycle record is in the failed phase.",
      candidateFailureDomains: ["floral", "host"],
      evidence: compactEvidenceRefs([evidenceRefIf(definition.id, phase), evidenceRefIf(definition.id, alive)]),
      checks: [
        check(1, "service-status", "Read the current service status and process liveness without changing lifecycle state.", "/status --debug"),
        check(2, "service-logs", "Inspect the service logs for the bounded failure type and startup boundary.", "service:logs"),
      ],
      limitations: ["The service-state record alone does not prove the underlying root cause."],
    });
  }
}

function diagnoseMaintenance(
  model: SystemReadModel,
  definition: SystemDefinition,
  findings: SystemDiagnosticFinding[],
): void {
  const transaction = factSnapshot(model, definition.id, "last_transaction");
  const value = resolvedRecord(transaction);
  if (!value) return;
  const status = readString(value.status);
  if (status === "failed") {
    findings.push({
      id: "floral.maintenance.last-transaction-failed",
      componentId: definition.id,
      severity: "warning",
      status: "degraded",
      impact: "degraded",
      confidence: "high",
      summary: "The latest governed maintenance transaction failed before post-action verification completed.",
      candidateFailureDomains: ["host", "floral"],
      evidence: compactEvidenceRefs([evidenceRefIf(definition.id, transaction)]),
      checks: [
        check(1, "maintenance-receipt", "Read the latest maintenance receipt and its bounded error type.", "floral_system/component_status"),
        check(2, "service-state", "Read FLORAL service state before considering another maintenance request.", "floral_system/component_status"),
      ],
      limitations: ["The receipt error type is bounded metadata and does not by itself prove the root cause."],
    });
  }
  if (status === "cancelled") {
    findings.push({
      id: "floral.maintenance.last-transaction-cancelled",
      componentId: definition.id,
      severity: "info",
      status: "inactive",
      impact: "none",
      confidence: "high",
      summary: "The latest approved maintenance transaction was cancelled before host handoff, so no restart was executed by that transaction.",
      candidateFailureDomains: ["floral"],
      evidence: compactEvidenceRefs([evidenceRefIf(definition.id, transaction)]),
      checks: [
        check(1, "maintenance-receipt", "Read the maintenance receipt to confirm the pre-handoff cancellation state.", "floral_system/component_status"),
      ],
      limitations: ["Cancellation describes the transaction lifecycle and is not evidence that the FLORAL service itself is unhealthy."],
    });
  }

  const autonomy = factSnapshot(model, definition.id, "autonomy_state");
  const autonomyValue = resolvedRecord(autonomy);
  if (autonomyValue && readBoolean(autonomyValue.circuit_breaker_open) === true) {
    findings.push({
      id: "floral.maintenance.autonomy-circuit-breaker-open",
      componentId: definition.id,
      severity: "warning",
      status: "degraded",
      impact: "degraded",
      confidence: "high",
      summary: "Maintenance Self-Heal circuit breaker is open after repeated automatic recovery failures; further autonomous repair attempts are suspended.",
      candidateFailureDomains: ["floral", "host"],
      evidence: compactEvidenceRefs([evidenceRefIf(definition.id, autonomy)]),
      checks: [
        check(1, "maintenance-policy", "Read the maintenance autonomy policy and latest receipt before the owner resets the breaker.", "floral_system/component_status"),
      ],
      limitations: ["An open circuit breaker intentionally blocks repeated automatic repair; owner-requested/manual maintenance remains separately governed."],
    });
  }
}

function diagnoseApps(
  model: SystemReadModel,
  definition: SystemDefinition,
  findings: SystemDiagnosticFinding[],
): void {
  const installed = factSnapshot(model, definition.id, "installed");
  const callable = factSnapshot(model, definition.id, "callability");
  const fallback = factSnapshot(model, definition.id, "directory_fallback");
  if (
    installed?.resolution === "unknown"
    && callable?.resolution === "unknown"
    && fallback?.resolution === "resolved"
  ) {
    findings.push({
      id: "codex.apps.installed-authority-unavailable",
      componentId: definition.id,
      severity: "info",
      status: "unknown",
      impact: "none",
      confidence: "high",
      summary: "App directory fallback is available, but app/installed did not provide installed/callable authority; directory visibility must not be upgraded to installed or callable state.",
      candidateFailureDomains: ["codex"],
      evidence: compactEvidenceRefs([
        evidenceRefIf(definition.id, installed),
        evidenceRefIf(definition.id, callable),
        evidenceRefIf(definition.id, fallback),
      ]),
      checks: [
        check(1, "apps-status", "Read the App directory and installed-runtime views again on a fresh turn.", "/apps"),
      ],
      limitations: ["This is an observability limitation, not proof that any App is broken or absent."],
    });
  }
}

function diagnoseBuiltinMcp(
  model: SystemReadModel,
  definition: SystemDefinition,
  findings: SystemDiagnosticFinding[],
): void {
  const configured = factSnapshot(model, definition.id, "configured");
  const runtime = factSnapshot(model, definition.id, "runtime");
  const configuredValue = resolvedRecord(configured);
  const enabled = configuredValue ? readBoolean(configuredValue.enabled) : undefined;
  if (enabled === false) return;
  if (enabled !== true || !configured) return;

  const secretMissing = missingSecretDependencies(model, definition);
  if (secretMissing.length > 0) {
    findings.push({
      id: `${definition.id}.missing-secret`,
      componentId: definition.id,
      severity: "error",
      status: "unavailable",
      impact: "unavailable",
      confidence: "high",
      summary: `The MCP is configured enabled, but required credential presence is missing: ${secretMissing.join(", ")}.`,
      candidateFailureDomains: ["host", definition.failureDomain],
      evidence: compactEvidenceRefs([
        evidenceRefIf(definition.id, configured),
        evidenceRefIf("floral.configuration", factSnapshot(model, "floral.configuration", "secret_presence")),
      ]),
      checks: [
        check(1, "credential-presence", "Confirm only credential presence metadata in System Awareness; do not reveal secret values.", "floral_system/component_status"),
        check(2, "mcp-runtime", "Read the current MCP runtime status after the credential prerequisite is provisioned by the owner.", "/mcp"),
      ],
      limitations: ["No credential value is inspected or returned by diagnostics."],
    });
    return;
  }

  if (!runtime || runtime.resolution === "unknown") {
    findings.push({
      id: `${definition.id}.runtime-unknown`,
      componentId: definition.id,
      severity: "warning",
      status: "unknown",
      impact: "degraded",
      confidence: "high",
      summary: "The MCP is configured enabled, but authoritative Codex MCP runtime readiness is unavailable for this snapshot.",
      candidateFailureDomains: ["codex", definition.failureDomain],
      evidence: compactEvidenceRefs([
        evidenceRefIf(definition.id, configured),
        evidenceRefIf(definition.id, runtime),
      ]),
      checks: [
        check(1, "mcp-status", "Read Codex MCP server status on a fresh turn without changing MCP configuration.", "/mcp"),
        check(2, "component-status", "Inspect the MCP component evidence and the reason attached to unknown runtime evidence.", "floral_system/component_status"),
      ],
      limitations: ["Missing runtime evidence does not prove startup failure."],
    });
    return;
  }

  const runtimeValue = resolvedRecord(runtime);
  if (!runtimeValue) return;
  diagnoseMcpRuntimeValue({
    definition,
    runtime,
    runtimeValue,
    configured,
    findings,
    findingPrefix: definition.id,
  });
}

function diagnoseExternalMcp(
  model: SystemReadModel,
  definition: SystemDefinition,
  findings: SystemDiagnosticFinding[],
): void {
  const packagesFact = factSnapshot(model, definition.id, "packages");
  const authFact = factSnapshot(model, definition.id, "auth_presence");
  const serversFact = factSnapshot(model, "codex.mcp", "servers");
  const packages = resolvedArrayOfRecords(packagesFact);
  if (!packages) return;
  const authRows = resolvedArrayOfRecords(authFact) ?? [];
  const servers = resolvedArrayOfRecords(serversFact);

  for (const entry of packages) {
    const id = readString(entry.id);
    const serverId = readString(entry.serverId);
    const enabled = readBoolean(entry.enabled);
    if (!id || !serverId || enabled !== true) continue;
    const auth = authRows.find((row) => readString(row.id) === id || readString(row.serverId) === serverId);
    const authRequired = auth ? readString(auth.requirement) !== "none" : undefined;
    const authPresent = auth ? readBoolean(auth.present) : undefined;

    if (authRequired === true && authPresent === false) {
      findings.push({
        id: `extensions.external_mcp.${safeToken(id)}.auth-missing`,
        componentId: definition.id,
        subjectId: id,
        severity: "error",
        status: "unavailable",
        impact: "unavailable",
        confidence: "high",
        summary: `External MCP ${id} is installed and enabled, but its required authentication prerequisite is absent.`,
        candidateFailureDomains: ["host", "third-party"],
        evidence: compactEvidenceRefs([
          evidenceRefIf(definition.id, packagesFact),
          evidenceRefIf(definition.id, authFact),
        ]),
        checks: [
          check(1, "auth-presence", "Confirm the presence-only authentication metadata for this curated MCP; never inspect or print the token value.", "floral_system/component_status"),
          check(2, "runtime-status", "After the owner provisions authentication, use a fresh turn to read MCP runtime status.", "floral_extensions/mcp_status"),
        ],
        limitations: ["Diagnostics cannot authenticate, install, enable, disable, or remove an MCP."],
      });
      continue;
    }

    if (!servers) {
      findings.push({
        id: `extensions.external_mcp.${safeToken(id)}.runtime-observation-unknown`,
        componentId: definition.id,
        subjectId: id,
        severity: "warning",
        status: "unknown",
        impact: "degraded",
        confidence: "high",
        summary: `External MCP ${id} is enabled, but Codex MCP server status is unavailable in this snapshot.`,
        candidateFailureDomains: ["codex"],
        evidence: compactEvidenceRefs([
          evidenceRefIf(definition.id, packagesFact),
          evidenceRefIf(definition.id, authFact),
          evidenceRefIf("codex.mcp", serversFact),
        ]),
        checks: [
          check(1, "mcp-status", "Read MCP runtime status again on a fresh turn.", "floral_extensions/mcp_status"),
          check(2, "system-component", "Inspect codex.mcp evidence and any unknown reason.", "floral_system/component_status"),
        ],
        limitations: ["Registry enabled state is not runtime readiness."],
      });
      continue;
    }

    const server = servers.find((row) => readString(row.name) === serverId);
    if (!server) {
      findings.push({
        id: `extensions.external_mcp.${safeToken(id)}.enabled-but-not-reported`,
        componentId: definition.id,
        subjectId: id,
        severity: "warning",
        status: "unavailable",
        impact: "degraded",
        confidence: authRequired === true && authPresent === true ? "high" : "medium",
        summary: `External MCP ${id} is installed and enabled${authRequired === true ? " with authentication present" : ""}, but Codex did not report server ${serverId}. The evidence points first to activation/runtime adoption rather than installation state.`,
        candidateFailureDomains: ["codex", "floral"],
        evidence: compactEvidenceRefs([
          evidenceRefIf(definition.id, packagesFact),
          evidenceRefIf(definition.id, authFact),
          evidenceRefIf("codex.mcp", serversFact),
        ]),
        checks: [
          check(1, "extension-runtime", "Use the governed MCP status interface to confirm whether the server is absent, starting, failed, or ready.", "floral_extensions/mcp_status"),
          check(2, "fresh-snapshot", "On the next turn, re-read codex.mcp to exclude a stale pre-mutation snapshot.", "floral_system/component_status"),
          check(3, "owner-mcp", "Use the owner-facing MCP status command for an independent read-only runtime view.", "/mcp"),
        ],
        limitations: ["The absence of a reported server does not by itself distinguish Codex reload/adoption failure from an upstream startup failure."],
      });
      continue;
    }

    const status = readString(server.status);
    if (status === "ready") {
      const tools = readArray(server.tools);
      if (tools && tools.length === 0) {
        findings.push({
          id: `extensions.external_mcp.${safeToken(id)}.ready-without-tools`,
          componentId: definition.id,
          subjectId: id,
          severity: "warning",
          status: "degraded",
          impact: "degraded",
          confidence: "high",
          summary: `External MCP ${id} reports ready but advertises no tools, so startup succeeded without a usable capability surface.`,
          candidateFailureDomains: ["codex", "third-party"],
          evidence: compactEvidenceRefs([
            evidenceRefIf(definition.id, packagesFact),
            evidenceRefIf("codex.mcp", serversFact),
          ]),
          checks: [
            check(1, "mcp-status", "Read the server tool list again on a fresh turn.", "floral_extensions/mcp_status"),
            check(2, "provider-health", "Check the upstream MCP service or stdio server health through its governed read-only status surface when available.", "floral_system/component_status"),
          ],
          limitations: ["Ready-without-tools is degraded capability, not proof of a specific upstream defect."],
        });
      }
      continue;
    }

    if (status === "starting") {
      findings.push({
        id: `extensions.external_mcp.${safeToken(id)}.still-starting`,
        componentId: definition.id,
        subjectId: id,
        severity: "warning",
        status: "degraded",
        impact: "degraded",
        confidence: "high",
        summary: `External MCP ${id} is still starting in the captured Codex runtime snapshot.`,
        candidateFailureDomains: ["codex", "network", "third-party"],
        evidence: compactEvidenceRefs([
          evidenceRefIf(definition.id, packagesFact),
          evidenceRefIf("codex.mcp", serversFact),
        ]),
        checks: [
          check(1, "fresh-runtime-status", "Read MCP status on a fresh turn to distinguish normal startup latency from a stuck startup.", "floral_extensions/mcp_status"),
        ],
        limitations: ["A single frozen snapshot cannot determine whether startup will later succeed."],
      });
      continue;
    }

    if (status === "failed" || status === "cancelled" || status === "unknown") {
      const reason = readString(server.failureReason);
      const authStatus = readString(server.authStatus);
      const authLike = looksLikeAuthFailure(`${authStatus ?? ""} ${reason ?? ""}`);
      findings.push({
        id: `extensions.external_mcp.${safeToken(id)}.runtime-${safeToken(status)}`,
        componentId: definition.id,
        subjectId: id,
        severity: status === "unknown" ? "warning" : "error",
        status: status === "unknown" ? "unknown" : "unavailable",
        impact: status === "unknown" ? "degraded" : "unavailable",
        confidence: reason || authStatus ? "medium" : "high",
        summary: authLike
          ? `External MCP ${id} is not ready and the bounded runtime metadata is consistent with an authentication failure.`
          : `External MCP ${id} is enabled but Codex reports runtime status ${status}.`,
        candidateFailureDomains: authLike
          ? ["third-party", "codex"]
          : ["codex", "network", "third-party"],
        evidence: compactEvidenceRefs([
          evidenceRefIf(definition.id, packagesFact),
          evidenceRefIf(definition.id, authFact),
          evidenceRefIf("codex.mcp", serversFact),
        ]),
        checks: [
          check(1, "mcp-status", "Read the governed MCP runtime status and bounded failure metadata again on a fresh turn.", "floral_extensions/mcp_status"),
          check(2, "auth-presence", "Compare credential presence metadata with runtime auth status without exposing secret values.", "floral_system/component_status"),
          check(3, "owner-mcp", "Use /mcp for the owner-facing runtime server/tool view.", "/mcp"),
        ],
        limitations: ["Failure-domain ordering is a hypothesis derived from registry/auth/runtime evidence; it is not a proven root cause."],
      });
    }
  }
}

function diagnoseMcpRuntimeValue(input: {
  definition: SystemDefinition;
  configured: SystemFactSnapshot;
  runtime: SystemFactSnapshot;
  runtimeValue: Readonly<Record<string, SystemEvidenceValue>>;
  findings: SystemDiagnosticFinding[];
  findingPrefix: string;
}): void {
  const status = readString(input.runtimeValue.status);
  if (status === "ready") {
    const configuredValue = resolvedRecord(input.configured);
    const configuredTools = configuredValue ? readArray(configuredValue.tools) : undefined;
    const runtimeTools = readArray(input.runtimeValue.tools);
    if ((configuredTools?.length ?? 0) > 0 && runtimeTools?.length === 0) {
      input.findings.push({
        id: `${input.findingPrefix}.ready-without-tools`,
        componentId: input.definition.id,
        severity: "warning",
        status: "degraded",
        impact: "degraded",
        confidence: "high",
        summary: "The MCP runtime reports ready but advertises no tools even though FLORAL configured an enabled tool surface.",
        candidateFailureDomains: ["codex", input.definition.failureDomain],
        evidence: [
          evidenceRef(input.definition.id, input.configured),
          evidenceRef(input.definition.id, input.runtime),
        ],
        checks: [
          check(1, "mcp-status", "Read the current server and advertised tool status on a fresh turn.", "/mcp"),
          check(2, "component-status", "Compare configured tool intent with runtime-advertised tools.", "floral_system/component_status"),
        ],
        limitations: ["A ready server with no tools is degraded, but this evidence does not prove which side omitted tool registration."],
      });
    }
    return;
  }

  if (status === "starting") {
    input.findings.push({
      id: `${input.findingPrefix}.still-starting`,
      componentId: input.definition.id,
      severity: "warning",
      status: "degraded",
      impact: "degraded",
      confidence: "high",
      summary: "The MCP is configured enabled and Codex still reports it as starting in this frozen snapshot.",
      candidateFailureDomains: ["codex", input.definition.failureDomain],
      evidence: [evidenceRef(input.definition.id, input.configured), evidenceRef(input.definition.id, input.runtime)],
      checks: [check(1, "fresh-runtime-status", "Re-read MCP status on the next turn to distinguish normal startup latency from a stuck startup.", "/mcp")],
      limitations: ["A single frozen snapshot cannot classify transient startup latency as a failure."],
    });
    return;
  }

  if (status === "failed" || status === "cancelled" || status === "unknown") {
    input.findings.push({
      id: `${input.findingPrefix}.runtime-${safeToken(status)}`,
      componentId: input.definition.id,
      severity: status === "unknown" ? "warning" : "error",
      status: status === "unknown" ? "unknown" : "unavailable",
      impact: status === "unknown" ? "degraded" : "unavailable",
      confidence: "high",
      summary: `The MCP is configured enabled but Codex reports runtime status ${status}.`,
      candidateFailureDomains: ["codex", input.definition.failureDomain],
      evidence: [evidenceRef(input.definition.id, input.configured), evidenceRef(input.definition.id, input.runtime)],
      checks: [
        check(1, "mcp-status", "Read the current MCP runtime status and bounded failure metadata on a fresh turn.", "/mcp"),
        check(2, "component-status", "Inspect configured intent and runtime evidence side by side.", "floral_system/component_status"),
      ],
      limitations: ["Runtime status identifies the failing layer but does not by itself prove the underlying process/provider cause."],
    });
  }
}

function diagnoseProviderCredential(
  model: SystemReadModel,
  definition: SystemDefinition,
  findings: SystemDiagnosticFinding[],
): void {
  const credential = factSnapshot(model, definition.id, "credential_present");
  if (resolvedBoolean(credential) !== false) return;
  findings.push({
    id: "deepseek.provider.credential-missing",
    componentId: definition.id,
    severity: "error",
    status: "unavailable",
    impact: "unavailable",
    confidence: "high",
    summary: "The configured DeepSeek provider credential is absent, so provider-backed model requests cannot be expected to authenticate.",
    candidateFailureDomains: ["host", "provider"],
    evidence: compactEvidenceRefs([evidenceRefIf(definition.id, credential)]),
    checks: [check(1, "provider-config", "Confirm provider credential presence metadata only; never expose the secret value.", "floral_system/component_status")],
    limitations: ["Diagnostics does not provision or validate the credential against the provider."],
  });
}

function diagnoseFeishuTransport(
  model: SystemReadModel,
  definition: SystemDefinition,
  findings: SystemDiagnosticFinding[],
): void {
  const mode = factSnapshot(model, definition.id, "configured_mode");
  const credentials = factSnapshot(model, definition.id, "credential_presence");
  if (resolvedString(mode) !== "selected") return;
  const value = resolvedRecord(credentials);
  if (!value) return;
  const appId = readBoolean(value.appId);
  const appSecret = readBoolean(value.appSecret);
  if (appId !== false && appSecret !== false) return;
  findings.push({
    id: "transport.feishu.selected-with-missing-credential",
    componentId: definition.id,
    severity: "error",
    status: "unavailable",
    impact: "unavailable",
    confidence: "high",
    summary: "Feishu is the selected transport, but one or more required credential-presence checks are false.",
    candidateFailureDomains: ["host", "transport"],
    evidence: compactEvidenceRefs([evidenceRefIf(definition.id, mode), evidenceRefIf(definition.id, credentials)]),
    checks: [check(1, "transport-config", "Confirm Feishu transport selection and credential presence metadata without revealing credentials.", "floral_system/component_status")],
    limitations: ["Credential presence does not prove upstream Feishu API reachability or validity."],
  });
}

function missingSecretDependencies(
  model: SystemReadModel,
  definition: SystemDefinition,
): string[] {
  if (definition.secretDependencies.length === 0) return [];
  const fact = factSnapshot(model, "floral.configuration", "secret_presence");
  const value = resolvedRecord(fact);
  if (!value) return [];
  const presenceByName = new Map<string, boolean>();
  for (const entry of Object.values(value)) {
    const record = asRecord(entry);
    const name = record ? readString(record.name) : undefined;
    const present = record ? readBoolean(record.present) : undefined;
    if (name && present !== undefined) presenceByName.set(name, present);
  }
  return definition.secretDependencies.filter((name) => presenceByName.get(name) === false);
}

function factSnapshot(
  model: SystemReadModel,
  componentId: string,
  fact: string,
): SystemFactSnapshot | undefined {
  return componentSnapshot(model, componentId)?.facts.find((entry) => entry.fact === fact);
}

function componentSnapshot(
  model: SystemReadModel,
  componentId: string,
): SystemComponentSnapshot | undefined {
  return model.snapshot.components.find((entry) => entry.componentId === componentId);
}

function resolvedString(fact: SystemFactSnapshot | undefined): string | undefined {
  return fact?.resolution === "resolved" ? readString(fact.value) : undefined;
}

function resolvedBoolean(fact: SystemFactSnapshot | undefined): boolean | undefined {
  return fact?.resolution === "resolved" ? readBoolean(fact.value) : undefined;
}

function resolvedRecord(
  fact: SystemFactSnapshot | undefined,
): Readonly<Record<string, SystemEvidenceValue>> | undefined {
  return fact?.resolution === "resolved" ? asRecord(fact.value) : undefined;
}

function resolvedArrayOfRecords(
  fact: SystemFactSnapshot | undefined,
): ReadonlyArray<Readonly<Record<string, SystemEvidenceValue>>> | undefined {
  if (fact?.resolution !== "resolved") return undefined;
  const array = readArray(fact.value);
  if (!array) return undefined;
  const records = array.map(asRecord);
  return records.every((record) => record !== undefined)
    ? records as ReadonlyArray<Readonly<Record<string, SystemEvidenceValue>>>
    : undefined;
}

function asRecord(
  value: SystemEvidenceValue | undefined,
): Readonly<Record<string, SystemEvidenceValue>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Readonly<Record<string, SystemEvidenceValue>>;
}

function readArray(value: SystemEvidenceValue | undefined): readonly SystemEvidenceValue[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function readString(value: SystemEvidenceValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readBoolean(value: SystemEvidenceValue | undefined): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function evidenceRef(
  componentId: string,
  fact: SystemFactSnapshot,
): SystemDiagnosticEvidenceRef {
  return {
    componentId,
    fact: fact.fact,
    resolution: fact.resolution,
    confidence: fact.confidence,
    sources: [...new Set(fact.evidence.map((item) => item.source.id))].sort(),
  };
}

function evidenceRefIf(
  componentId: string,
  fact: SystemFactSnapshot | undefined,
): SystemDiagnosticEvidenceRef | undefined {
  return fact ? evidenceRef(componentId, fact) : undefined;
}

function compactEvidenceRefs(
  values: readonly (SystemDiagnosticEvidenceRef | undefined)[],
): SystemDiagnosticEvidenceRef[] {
  return values.filter((item): item is SystemDiagnosticEvidenceRef => Boolean(item));
}

function check(
  order: number,
  id: string,
  description: string,
  interfaceName: string,
): SystemDiagnosticCheck {
  return {
    order,
    id,
    description,
    interface: interfaceName,
    readOnly: true,
  };
}

function overallStatus(
  findings: readonly SystemDiagnosticFinding[],
): SystemDiagnosticReport["overallStatus"] {
  if (findings.some((finding) => finding.impact === "conflict")) return "conflict";
  if (findings.some((finding) => finding.impact === "unavailable")) return "unavailable";
  if (findings.some((finding) => finding.impact === "degraded")) return "degraded";
  return "healthy";
}

function compareFindings(left: SystemDiagnosticFinding, right: SystemDiagnosticFinding): number {
  const impact = impactRank(right.impact) - impactRank(left.impact);
  if (impact !== 0) return impact;
  const severity = severityRank(right.severity) - severityRank(left.severity);
  if (severity !== 0) return severity;
  return left.id.localeCompare(right.id);
}

function impactRank(value: SystemDiagnosticImpact): number {
  if (value === "conflict") return 3;
  if (value === "unavailable") return 2;
  if (value === "degraded") return 1;
  return 0;
}

function severityRank(value: SystemDiagnosticSeverity): number {
  if (value === "error") return 2;
  if (value === "warning") return 1;
  return 0;
}

function looksLikeAuthFailure(value: string): boolean {
  return /(auth|token|credential|unauthori[sz]ed|forbidden|\b401\b|\b403\b)/iu.test(value);
}

function boundedText(value: string, maxLength: number): string {
  const normalized = value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, " ")
    .trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 20)}\ntruncated=true`;
}

function safeToken(value: string): string {
  const normalized = value
    .replace(/[^A-Za-z0-9._:/-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 160);
  return normalized || "unknown";
}
