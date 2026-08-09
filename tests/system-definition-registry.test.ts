import { describe, expect, it } from "vitest";
import {
  DEFAULT_SYSTEM_DEFINITIONS,
  createDefaultSystemDefinitionRegistry,
} from "../src/system-awareness/default-system-definitions.js";
import { SystemDefinitionRegistry } from "../src/system-awareness/system-definition-registry.js";
import { approvalLevelFor } from "../src/policy/approval.js";
import {
  SYSTEM_AWARENESS_SCHEMA_VERSION,
  type SystemDefinition,
} from "../src/system-awareness/system-types.js";

describe("Phase 8A system definition registry", () => {
  it("freezes the authority split for Apps, MCP, service restart, and curated extensions", () => {
    const registry = createDefaultSystemDefinitionRegistry();
    const apps = registry.require("codex.apps");
    expect(apps.stateSources.find((source) => source.id === "codex-app-installed")?.facts)
      .toContain("installed");
    expect(apps.stateSources.find((source) => source.id === "codex-app-directory")?.facts)
      .toContain("directory");
    expect(apps.managementActions.find((action) => action.id === "install")).toMatchObject({
      disposition: "user-mediated",
      approval: "user-mediated",
    });
    expect(apps.managementActions.find((action) => action.id === "remove")).toMatchObject({
      disposition: "unsupported",
    });

    expect(registry.require("floral.service").managementActions.find((action) => action.id === "restart"))
      .toMatchObject({
        disposition: "host-only",
        approval: "local-confirmation",
        capability: "system.restart",
      });

    for (const id of ["extensions.external_skills", "extensions.external_mcp"]) {
      const lifecycle = registry.require(id).managementActions.filter((action) =>
        ["install", "update", "enable", "disable", "remove"].includes(action.id),
      );
      expect(lifecycle).toHaveLength(5);
      expect(lifecycle.every((action) => action.capability === "software.install")).toBe(true);
      expect(lifecycle.every((action) => action.approval === approvalLevelFor("software.install"))).toBe(true);
    }
    expect(registry.require("floral.service").managementActions.find((action) => action.id === "restart")?.approval)
      .toBe(approvalLevelFor("system.restart"));
  });

  it("keeps secret dependencies as names rather than credential values", () => {
    const registry = createDefaultSystemDefinitionRegistry();
    const serialized = JSON.stringify(registry.list());
    expect(serialized).toContain("DEEPSEEK_API_KEY");
    expect(serialized).toContain("GITHUB_PAT_TOKEN");
    expect(serialized).not.toContain("ghp_");
    expect(serialized).not.toContain("sk-");
  });

  it("returns defensive copies and a stable fingerprint", () => {
    const registry = createDefaultSystemDefinitionRegistry();
    const first = registry.require("codex.apps");
    (first.tags as string[]).push("mutated-outside-registry");
    expect(registry.require("codex.apps").tags).not.toContain("mutated-outside-registry");
    expect(registry.fingerprint()).toBe(createDefaultSystemDefinitionRegistry().fingerprint());
  });

  it("rejects duplicate ids and unknown parents", () => {
    const sample = minimalDefinition("sample.component");
    expect(() => new SystemDefinitionRegistry([sample, sample])).toThrow(/Duplicate/u);
    expect(() => new SystemDefinitionRegistry([{
      ...minimalDefinition("child.component"),
      parentId: "missing.parent",
    }])).toThrow(/unknown parent/u);
  });

  it("keeps the default census internally valid", () => {
    expect(DEFAULT_SYSTEM_DEFINITIONS.length).toBeGreaterThanOrEqual(15);
    expect(() => createDefaultSystemDefinitionRegistry()).not.toThrow();
  });
});

function minimalDefinition(id: string): SystemDefinition {
  return {
    schemaVersion: SYSTEM_AWARENESS_SCHEMA_VERSION,
    id,
    displayName: id,
    description: "test definition",
    kind: "runtime",
    owner: {
      party: "floral",
      name: "test owner",
      responsibility: "test ownership",
    },
    authority: {
      party: "floral",
      name: "test authority",
      responsibility: "test authority",
    },
    stateSources: [{
      id: "test-source",
      kind: "probe",
      authority: "observational",
      facts: ["status"],
      description: "test source",
    }],
    managementActions: [],
    secretDependencies: [],
    failureDomain: "floral",
    tags: ["test"],
  };
}
