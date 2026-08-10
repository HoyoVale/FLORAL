import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildConfigurationInventory,
  extractEnvironmentExampleKeys,
  extractEnvironmentSchemaKeys,
  inventoryHasErrors,
  loadUpstreamConfigCatalog,
  renderConfigurationInventory,
} from "../src/config/inventory/config-inventory.js";

const repositoryRoot = resolve(".");

describe("configuration inventory", () => {
  it("keeps env schema and documented example keys in lockstep", async () => {
    const inventory = await buildConfigurationInventory({
      repositoryRoot,
      includeRuntimeProbes: false,
      now: new Date("2026-08-06T00:00:00.000Z"),
    });

    expect(inventory.explicitEnvironment.schemaKeys.length).toBeGreaterThan(40);
    expect(inventory.explicitEnvironment.schemaOnlyKeys).toEqual([]);
    expect(inventory.explicitEnvironment.exampleOnlyKeys).toEqual([]);
    expect(inventoryHasErrors(inventory)).toBe(false);
  });

  it("freezes every hardcoded decision against source evidence", async () => {
    const inventory = await buildConfigurationInventory({
      repositoryRoot,
      includeRuntimeProbes: false,
    });

    expect(inventory.hardcodedDecisions.length).toBeGreaterThanOrEqual(26);
    expect(
      inventory.hardcodedDecisions.filter((decision) => !decision.evidenceFound),
    ).toEqual([]);
    expect(inventory.components.map((component) => component.id)).toEqual(
      expect.arrayContaining([
        "codex",
        "deepseek",
        "searxng",
        "qq-sdk",
        "feishu-sdk",
        "mcp",
        "better-auth",
        "peekaboo",
        "mimo-vision",
      ]),
    );
  });

  it("produces a stable source fingerprint without reading secret values", async () => {
    const first = await buildConfigurationInventory({
      repositoryRoot,
      includeRuntimeProbes: false,
      now: new Date("2026-08-06T00:00:00.000Z"),
    });
    const second = await buildConfigurationInventory({
      repositoryRoot,
      includeRuntimeProbes: false,
      now: new Date("2026-08-07T00:00:00.000Z"),
    });

    expect(first.sourceFingerprint).toBe(second.sourceFingerprint);
    expect(first.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
    const rendered = renderConfigurationInventory(first);
    expect(rendered).not.toContain("DEEPSEEK_API_KEY=");
    expect(rendered).not.toContain("QQBOT_APP_SECRET=");
    expect(rendered).toContain("config.inventory=ok");
  });

  it("validates catalog shape and extraction helpers", async () => {
    const catalog = await loadUpstreamConfigCatalog(repositoryRoot);
    expect(catalog.schemaVersion).toBe(1);
    const environmentKeys = Object.keys(catalog.environmentKeyPolicies);
    expect(environmentKeys).toHaveLength(84);
    expect(environmentKeys).toEqual(expect.arrayContaining([
      "FLORAL_MAINTENANCE_MODE_CEILING",
      "FLORAL_MAINTENANCE_MAX_ACTIONS_PER_HOUR",
      "FLORAL_MAINTENANCE_COOLDOWN_MS",
      "FLORAL_MAINTENANCE_FAILURE_THRESHOLD",
      "FLORAL_MAINTENANCE_SELF_HEAL_INTERVAL_MS",
    ]));
    expect(catalog.classifications).toEqual([
      "floral-owned",
      "upstream-managed",
      "upstream-passthrough",
      "observed-only",
      "locked",
    ]);
    expect(extractEnvironmentSchemaKeys("const x = {\n  TEST_VALUE: value,\n};")).toEqual([
      "TEST_VALUE",
    ]);
    expect(extractEnvironmentExampleKeys("TEST_VALUE=1\n# X\nOTHER=\n")).toEqual([
      "OTHER",
      "TEST_VALUE",
    ]);
  });
});
