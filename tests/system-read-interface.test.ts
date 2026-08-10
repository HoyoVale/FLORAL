import { describe, expect, it } from "vitest";
import {
  SYSTEM_AWARENESS_SCHEMA_VERSION,
  createDefaultSystemDefinitionRegistry,
  formatSystemCapabilities,
  formatSystemComponentStatus,
  formatSystemRuntimeContext,
  formatSystemSummary,
  validateSystemReadModel,
  type SystemReadModel,
  type SystemSnapshot,
} from "../src/system-awareness/index.js";

function createModel(): SystemReadModel {
  const registry = createDefaultSystemDefinitionRegistry();
  const snapshot: SystemSnapshot = {
    schemaVersion: SYSTEM_AWARENESS_SCHEMA_VERSION,
    generatedAt: "2026-08-10T00:00:00.000Z",
    definitionFingerprint: registry.fingerprint(),
    components: [
      {
        componentId: "floral.service",
        observed: true,
        facts: [
          {
            fact: "recorded.phase",
            resolution: "resolved",
            confidence: "authoritative",
            value: "ready",
            evidence: [{
              componentId: "floral.service",
              fact: "recorded.phase",
              source: { id: "service-state", kind: "filesystem" },
              observedAt: "2026-08-10T00:00:00.000Z",
              confidence: "authoritative",
              scope: "machine",
              value: "ready",
            }],
          },
          {
            fact: "process.alive",
            resolution: "conflict",
            confidence: "unknown",
            value: null,
            evidence: [
              {
                componentId: "floral.service",
                fact: "process.alive",
                source: { id: "process-a", kind: "process" },
                observedAt: "2026-08-10T00:00:00.000Z",
                confidence: "observed",
                scope: "machine",
                value: true,
              },
              {
                componentId: "floral.service",
                fact: "process.alive",
                source: { id: "process-b", kind: "probe" },
                observedAt: "2026-08-10T00:00:00.000Z",
                confidence: "observed",
                scope: "machine",
                value: false,
              },
            ],
          },
        ],
      },
      {
        componentId: "floral.configuration",
        observed: true,
        facts: [{
          fact: "secret_presence",
          resolution: "resolved",
          confidence: "authoritative",
          value: { DEEPSEEK_API_KEY: true },
          evidence: [{
            componentId: "floral.configuration",
            fact: "secret_presence",
            source: { id: "configuration-authority", kind: "configuration" },
            observedAt: "2026-08-10T00:00:00.000Z",
            confidence: "authoritative",
            scope: "machine",
            value: { DEEPSEEK_API_KEY: true },
          }],
        }],
      },
    ],
    observers: [
      {
        observerId: "configuration",
        status: "ok",
        observedAt: "2026-08-10T00:00:00.000Z",
        evidenceCount: 1,
      },
      {
        observerId: "codex-runtime",
        status: "failed",
        observedAt: "2026-08-10T00:00:00.000Z",
        evidenceCount: 0,
        errorType: "CodexRuntimeError",
      },
    ],
  };
  return { definitions: registry.list(), snapshot };
}

describe("Phase 8A.5 read-only System Awareness interface", () => {
  it("summarizes resolved, unknown, and conflicting facts without inventing missing state", () => {
    const text = formatSystemSummary(createModel());
    expect(text).toContain("FLORAL System Awareness");
    expect(text).toContain("facts_conflict=1");
    expect(text).toMatch(/facts_unknown=[1-9][0-9]*/u);
    expect(text).toContain("observer=codex-runtime status=failed");
    expect(text).toContain("snapshot_semantics=read-only-per-turn-frozen");
    expect(text).toContain("unknown_semantics=unknown-is-a-valid-state-and-must-not-be-upgraded-by-guessing");
  });

  it("shows component authority and evidence provenance while exposing secret names only", () => {
    const text = formatSystemComponentStatus(createModel(), "floral.configuration");
    expect(text).toContain("component=floral.configuration");
    expect(text).toContain("authority_name=\"ConfigurationAuthority\"");
    expect(text).toContain("fact=secret_presence resolution=resolved confidence=authoritative");
    expect(text).toContain("DEEPSEEK_API_KEY");
    expect(text).toContain("secret_semantics=dependency-and-presence-metadata-only-never-secret-values");
    expect(text).not.toContain("never-print-this");
  });


  it("renders Gateway request and effective turn selector without treating generic runtime prose as authority", () => {
    const registry = createDefaultSystemDefinitionRegistry();
    const executionDefinition = registry.require("floral.execution");
    const evidence = (fact: string, value: string, source: string, scope: "conversation" | "runtime") => ({
      componentId: "floral.execution",
      fact,
      source: { id: source, kind: "runtime-context" as const },
      observedAt: "2026-08-10T00:00:00.000Z",
      confidence: "authoritative" as const,
      scope,
      value,
    });
    const facts = [
      evidence("gateway.control_mode", "full", "gateway-execution-policy", "conversation"),
      evidence("gateway.requested_sandbox", "danger-full-access", "gateway-execution-policy", "conversation"),
      evidence("gateway.requested_approval_policy", "untrusted", "gateway-execution-policy", "conversation"),
      evidence("gateway.requested_approvals_reviewer", "user", "gateway-execution-policy", "conversation"),
      evidence("gateway.approval_route", "full-auto-owner-trusted", "gateway-execution-policy", "conversation"),
      evidence("turn.selector", "permission-profile", "codex-turn-execution", "runtime"),
      evidence("turn.sandbox_mode", "not-applicable", "codex-turn-execution", "runtime"),
      evidence("turn.permission_profile", "floral-project", "codex-turn-execution", "runtime"),
      evidence("turn.approval_policy", "untrusted", "codex-turn-execution", "runtime"),
      evidence("turn.approvals_reviewer", "user", "codex-turn-execution", "runtime"),
    ];
    const model: SystemReadModel = {
      definitions: registry.list(),
      snapshot: {
        schemaVersion: SYSTEM_AWARENESS_SCHEMA_VERSION,
        generatedAt: "2026-08-10T00:00:00.000Z",
        definitionFingerprint: registry.fingerprint(),
        components: [{
          componentId: executionDefinition.id,
          observed: true,
          facts: facts.map((item) => ({
            fact: item.fact,
            resolution: "resolved" as const,
            confidence: "authoritative" as const,
            value: item.value,
            evidence: [item],
          })),
        }],
        observers: [],
      },
    };
    const text = formatSystemRuntimeContext(model);
    expect(text).toContain("FLORAL Runtime Self-Awareness");
    expect(text).toContain('fact=gateway.requested_sandbox resolution=resolved confidence=authoritative value="danger-full-access"');
    expect(text).toContain('fact=turn.selector resolution=resolved confidence=authoritative value="permission-profile"');
    expect(text).toContain('fact=turn.permission_profile resolution=resolved confidence=authoritative value="floral-project"');
    expect(text).toContain("precedence=turn-effective-selector-over-gateway-request-over-configured-default");
    expect(text).toContain("generic-model-environment-context-is-not-a-FLORAL-authority-source");
  });

  it("does not materialize contextual execution facts as unknown when there is no execution context", () => {
    const text = formatSystemSummary(createModel());
    expect(text).toContain("component=floral.execution kind=runtime observed=false resolved=0 unknown=0 conflict=0");
  });

  it("describes management contracts without granting authorization or executing them", () => {
    const text = formatSystemCapabilities(createModel(), "floral.service");
    expect(text).toContain("component=floral.service action=restart");
    expect(text).toContain("disposition=host-only");
    expect(text).toContain("approval=autonomy-policy");
    expect(text).toContain("capability=system.restart");
    expect(text).toContain("executor=system-maintenance/service-restart-worker");
    expect(text).toContain("authorization_granted=false");
    expect(text).toContain("execution_performed=false");
    expect(text).toContain("next_step=self-maintenance-is-not-enabled-by-this-interface");
  });

  it("rejects definition/snapshot mismatches", () => {
    const model = createModel();
    expect(() => validateSystemReadModel({
      ...model,
      snapshot: { ...model.snapshot, definitionFingerprint: "0".repeat(64) },
    })).toThrow(/fingerprint mismatch/u);
  });
});
