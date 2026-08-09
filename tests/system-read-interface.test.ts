import { describe, expect, it } from "vitest";
import {
  SYSTEM_AWARENESS_SCHEMA_VERSION,
  createDefaultSystemDefinitionRegistry,
  formatSystemCapabilities,
  formatSystemComponentStatus,
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

  it("describes management contracts without granting authorization or executing them", () => {
    const text = formatSystemCapabilities(createModel(), "floral.service");
    expect(text).toContain("component=floral.service action=restart");
    expect(text).toContain("disposition=host-only");
    expect(text).toContain("approval=local-confirmation");
    expect(text).toContain("capability=system.restart");
    expect(text).toContain("executor=scripts/service.ts");
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
