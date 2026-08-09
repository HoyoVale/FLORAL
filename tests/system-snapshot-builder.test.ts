import { describe, expect, it } from "vitest";
import { SystemDefinitionRegistry } from "../src/system-awareness/system-definition-registry.js";
import {
  SystemSnapshotBuilder,
  resolveSystemFact,
} from "../src/system-awareness/system-snapshot-builder.js";
import {
  SYSTEM_AWARENESS_SCHEMA_VERSION,
  type SystemDefinition,
  type SystemEvidence,
  type SystemObserver,
} from "../src/system-awareness/system-types.js";

describe("Phase 8A system snapshot builder", () => {
  it("prefers authoritative evidence over a conflicting observation", () => {
    const result = resolveSystemFact("status", [
      evidence("observed-source", "observed", "down", "2026-08-10T00:00:00.000Z"),
      evidence("authority-source", "authoritative", "ready", "2026-08-10T00:00:00.000Z"),
    ]);
    expect(result).toMatchObject({
      resolution: "resolved",
      confidence: "authoritative",
      value: "ready",
    });
  });

  it("does not guess when equally authoritative sources conflict", () => {
    const result = resolveSystemFact("status", [
      evidence("authority-a", "authoritative", "ready", "2026-08-10T00:00:00.000Z"),
      evidence("authority-b", "authoritative", "failed", "2026-08-10T00:00:00.000Z"),
    ]);
    expect(result).toMatchObject({
      resolution: "conflict",
      confidence: "unknown",
      value: null,
    });
    expect(result.evidence).toHaveLength(2);
  });

  it("lets a newer observation from the same source replace the older value", () => {
    const result = resolveSystemFact("status", [
      evidence("runtime", "observed", "starting", "2026-08-10T00:00:00.000Z"),
      evidence("runtime", "observed", "ready", "2026-08-10T00:00:01.000Z"),
    ]);
    expect(result).toMatchObject({
      resolution: "resolved",
      confidence: "observed",
      value: "ready",
    });
  });

  it("keeps unknown as a first-class result", () => {
    const result = resolveSystemFact("callable", [
      evidence("app-installed", "unknown", null, "2026-08-10T00:00:00.000Z"),
    ]);
    expect(result).toMatchObject({
      resolution: "unknown",
      confidence: "unknown",
      value: null,
    });
  });

  it("contains observer failure without turning unobserved components into invented state", async () => {
    const registry = new SystemDefinitionRegistry([minimalDefinition()]);
    const failingObserver: SystemObserver = {
      id: "failing-observer",
      componentIds: ["test.component"],
      observe: async () => {
        throw new TypeError("sensitive details must not be copied into snapshot");
      },
    };
    const builder = new SystemSnapshotBuilder({
      registry,
      observers: [failingObserver],
      now: () => new Date("2026-08-10T00:00:00.000Z"),
    });
    const snapshot = await builder.build();
    expect(snapshot.observers).toEqual([{
      observerId: "failing-observer",
      status: "failed",
      observedAt: "2026-08-10T00:00:00.000Z",
      evidenceCount: 0,
      errorType: "TypeError",
    }]);
    expect(snapshot.components).toEqual([{
      componentId: "test.component",
      observed: false,
      facts: [],
    }]);
    expect(JSON.stringify(snapshot)).not.toContain("sensitive details");
  });
});

function evidence(
  sourceId: string,
  confidence: SystemEvidence["confidence"],
  value: SystemEvidence["value"],
  observedAt: string,
): SystemEvidence {
  return {
    componentId: "test.component",
    fact: "status",
    source: { id: sourceId, kind: "probe" },
    observedAt,
    confidence,
    scope: "runtime",
    value,
  };
}

function minimalDefinition(): SystemDefinition {
  return {
    schemaVersion: SYSTEM_AWARENESS_SCHEMA_VERSION,
    id: "test.component",
    displayName: "Test Component",
    description: "test component",
    kind: "runtime",
    owner: { party: "floral", name: "test", responsibility: "test" },
    authority: { party: "floral", name: "test", responsibility: "test" },
    stateSources: [{
      id: "test-source",
      kind: "probe",
      authority: "observational",
      facts: ["status"],
      description: "test",
    }],
    managementActions: [],
    secretDependencies: [],
    failureDomain: "floral",
    tags: ["test"],
  };
}
