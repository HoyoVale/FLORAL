import { describe, expect, it } from "vitest";
import {
  SYSTEM_AWARENESS_SCHEMA_VERSION,
  buildSystemDiagnosticReport,
  createDefaultSystemDefinitionRegistry,
  formatSystemDiagnostics,
  type SystemComponentSnapshot,
  type SystemEvidence,
  type SystemFactSnapshot,
  type SystemReadModel,
} from "../src/system-awareness/index.js";

const NOW = "2026-08-10T00:00:00.000Z";

describe("Phase 8C deterministic self-diagnostics", () => {
  it("detects a stale ready service record without performing maintenance", () => {
    const model = modelWith([
      component("floral.service", [
        fact("floral.service", "recorded.phase", "ready", "authoritative", "service-state", "filesystem"),
        fact("floral.service", "process.alive", false, "observed", "process-liveness", "process"),
      ]),
    ]);

    const report = buildSystemDiagnosticReport(model, "floral.service");
    expect(report.overallStatus).toBe("unavailable");
    expect(report.executionPerformed).toBe(false);
    expect(report.maintenanceEnabled).toBe(false);
    expect(report.findings).toContainEqual(expect.objectContaining({
      id: "floral.service.ready-but-process-dead",
      impact: "unavailable",
      candidateFailureDomains: ["host", "floral"],
    }));
    expect(formatSystemDiagnostics(model, "floral.service")).toContain("execution_performed=false");
  });

  it("localizes enabled authenticated External MCP absence toward Codex activation/runtime", () => {
    const model = modelWith([
      component("extensions.external_mcp", [
        fact("extensions.external_mcp", "packages", [{
          id: "github-readonly",
          serverId: "github",
          enabled: true,
          installedAt: NOW,
          updatedAt: NOW,
        }], "authoritative", "external-mcp-registry", "registry"),
        fact("extensions.external_mcp", "auth_presence", [{
          id: "github-readonly",
          serverId: "github",
          requirement: "bearer-env",
          env: "GITHUB_PAT_TOKEN",
          present: true,
        }], "authoritative", "external-mcp-auth", "environment"),
      ]),
      component("codex.mcp", [
        fact("codex.mcp", "servers", [], "authoritative", "codex-mcp-status", "runtime-rpc"),
      ]),
    ]);

    const report = buildSystemDiagnosticReport(model, "extensions.external_mcp");
    const finding = report.findings.find((item) =>
      item.id === "extensions.external_mcp.github-readonly.enabled-but-not-reported"
    );
    expect(finding).toMatchObject({
      severity: "warning",
      status: "unavailable",
      candidateFailureDomains: ["codex", "floral"],
      confidence: "high",
    });
    expect(finding?.summary).toContain("activation/runtime adoption");
    expect(finding?.checks.every((check) => check.readOnly)).toBe(true);
  });

  it("identifies missing External MCP authentication before blaming runtime adoption", () => {
    const model = modelWith([
      component("extensions.external_mcp", [
        fact("extensions.external_mcp", "packages", [{
          id: "github-readonly",
          serverId: "github",
          enabled: true,
          installedAt: NOW,
          updatedAt: NOW,
        }], "authoritative", "external-mcp-registry", "registry"),
        fact("extensions.external_mcp", "auth_presence", [{
          id: "github-readonly",
          serverId: "github",
          requirement: "bearer-env",
          env: "GITHUB_PAT_TOKEN",
          present: false,
        }], "authoritative", "external-mcp-auth", "environment"),
      ]),
      component("codex.mcp", [
        fact("codex.mcp", "servers", [], "authoritative", "codex-mcp-status", "runtime-rpc"),
      ]),
    ]);

    const report = buildSystemDiagnosticReport(model, "extensions.external_mcp");
    const finding = report.findings.find((item) =>
      item.id === "extensions.external_mcp.github-readonly.auth-missing"
    );
    expect(finding).toMatchObject({
      severity: "error",
      impact: "unavailable",
      candidateFailureDomains: ["host", "third-party"],
    });
    expect(report.findings.some((item) => item.id.includes("enabled-but-not-reported"))).toBe(false);
  });

  it("separates built-in MCP configured intent from failed Codex runtime state", () => {
    const model = modelWith([
      component("mcp.floral_search", [
        fact("mcp.floral_search", "configured", {
          id: "floral_search",
          enabled: true,
          integrationStatus: "active",
          required: true,
          tools: [{ name: "web_search", approvalMode: "auto" }],
        }, "authoritative", "floral-mcp-registry", "configuration"),
        fact("mcp.floral_search", "runtime", {
          name: "floral_search",
          status: "failed",
          authStatus: null,
          failureReason: "spawn-failed",
          tools: [],
        }, "authoritative", "codex-mcp-status", "runtime-rpc"),
      ]),
    ]);

    const report = buildSystemDiagnosticReport(model, "mcp.floral_search");
    expect(report.findings).toContainEqual(expect.objectContaining({
      id: "mcp.floral_search.runtime-failed",
      status: "unavailable",
      candidateFailureDomains: ["codex", "mixed"],
    }));
  });

  it("treats App directory fallback as an informational authority gap, not a broken App", () => {
    const model = modelWith([
      component("codex.apps", [
        unknownFact("codex.apps", "installed", "codex-app-installed", "runtime-rpc", "app-installed-unavailable"),
        unknownFact("codex.apps", "callability", "codex-app-installed", "runtime-rpc", "app-installed-unavailable"),
        fact("codex.apps", "directory_fallback", [{ id: "calendar", source: "directory-fallback" }], "observed", "codex-app-fallback", "runtime-rpc"),
      ]),
    ]);

    const report = buildSystemDiagnosticReport(model, "codex.apps");
    expect(report.overallStatus).toBe("healthy");
    expect(report.findings).toContainEqual(expect.objectContaining({
      id: "codex.apps.installed-authority-unavailable",
      severity: "info",
      status: "unknown",
      impact: "none",
    }));
  });

  it("keeps conflicts explicit and never auto-selects a winner", () => {
    const conflict: SystemFactSnapshot = {
      fact: "process.alive",
      resolution: "conflict",
      confidence: "unknown",
      value: null,
      evidence: [
        evidence("floral.service", "process.alive", true, "observed", "process-a", "process"),
        evidence("floral.service", "process.alive", false, "observed", "process-b", "probe"),
      ],
    };
    const model = modelWith([component("floral.service", [conflict])]);
    const report = buildSystemDiagnosticReport(model, "floral.service");
    expect(report.overallStatus).toBe("conflict");
    expect(report.findings[0]).toMatchObject({
      id: "floral.service.process.alive.evidence-conflict",
      status: "conflict",
      impact: "conflict",
    });
  });
});

function modelWith(components: SystemComponentSnapshot[]): SystemReadModel {
  const registry = createDefaultSystemDefinitionRegistry();
  return {
    definitions: registry.list(),
    snapshot: {
      schemaVersion: SYSTEM_AWARENESS_SCHEMA_VERSION,
      generatedAt: NOW,
      definitionFingerprint: registry.fingerprint(),
      components,
      observers: [{
        observerId: "fixture",
        status: "ok",
        observedAt: NOW,
        evidenceCount: components.reduce((count, item) => count + item.facts.length, 0),
      }],
    },
  };
}

function component(componentId: string, facts: SystemFactSnapshot[]): SystemComponentSnapshot {
  return { componentId, observed: facts.length > 0, facts };
}

function fact(
  componentId: string,
  name: string,
  value: SystemFactSnapshot["value"],
  confidence: Exclude<SystemFactSnapshot["confidence"], "unknown">,
  sourceId: string,
  sourceKind: SystemEvidence["source"]["kind"],
): SystemFactSnapshot {
  return {
    fact: name,
    resolution: "resolved",
    confidence,
    value,
    evidence: [evidence(componentId, name, value, confidence, sourceId, sourceKind)],
  };
}

function unknownFact(
  componentId: string,
  name: string,
  sourceId: string,
  sourceKind: SystemEvidence["source"]["kind"],
  reason: string,
): SystemFactSnapshot {
  return {
    fact: name,
    resolution: "unknown",
    confidence: "unknown",
    value: null,
    evidence: [evidence(componentId, name, null, "unknown", sourceId, sourceKind, reason)],
  };
}

function evidence(
  componentId: string,
  factName: string,
  value: SystemEvidence["value"],
  confidence: SystemEvidence["confidence"],
  sourceId: string,
  sourceKind: SystemEvidence["source"]["kind"],
  reason?: string,
): SystemEvidence {
  return {
    componentId,
    fact: factName,
    source: { id: sourceId, kind: sourceKind },
    observedAt: NOW,
    confidence,
    scope: sourceKind === "runtime-rpc" ? "runtime" : "machine",
    value,
    ...(reason ? { reason } : {}),
  };
}
