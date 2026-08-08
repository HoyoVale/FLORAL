import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderCodexConfig } from "../src/config/adapters/codex-native-config.js";
import {
  assessMcpRegistryAdoptionReport,
  createMcpRegistryAdoptionReport,
  readMcpRegistryAdoptionReport,
  writeMcpRegistryAdoptionReport,
} from "../src/config/adoption/mcp-registry-adoption.js";
import { resolveConfigurationAuthority } from "../src/config/federation/config-authority.js";
import { buildMcpRuntimeRegistry } from "../src/config/mcp/mcp-runtime-registry.js";

async function fixture() {
  const authority = await resolveConfigurationAuthority({
    repositoryRoot: process.cwd(),
    environment: {},
  });
  const registry = buildMcpRuntimeRegistry(authority.effective);
  const codexConfig = renderCodexConfig(
    authority.effective,
    "http://127.0.0.1:9999/v1",
    registry,
  );
  return { authority, registry, codexConfig };
}

describe("MCP registry runtime adoption", () => {
  it("records an active registry projection without configuration values", async () => {
    const { authority, registry, codexConfig } = await fixture();
    const report = createMcpRegistryAdoptionReport({
      effectiveFingerprint: authority.effectiveFingerprint,
      registry,
      codexConfig,
      now: new Date("2026-08-07T03:00:00.000Z"),
    });
    expect(assessMcpRegistryAdoptionReport(report, registry, codexConfig)).toBe("active");
    expect(report.activeServerIds).toEqual(["floral_peekaboo", "floral_search"]);
    expect(report.toolAllowlists).toEqual({
      floral_peekaboo: ["image", "see"],
      floral_search: ["searxng_web_search"],
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("http://127.0.0.1:8888");
    expect(serialized).not.toContain("mcp-searxng");
  });

  it("detects current registry or Codex MCP projection drift", async () => {
    const { authority, registry, codexConfig } = await fixture();
    const report = createMcpRegistryAdoptionReport({
      effectiveFingerprint: authority.effectiveFingerprint,
      registry,
      codexConfig,
    });
    const changed = codexConfig.replace(
      'approval_mode = "approve"',
      'approval_mode = "prompt"',
    );
    expect(assessMcpRegistryAdoptionReport(report, registry, changed)).toBe("drift");

    const metadataDrift = structuredClone(report);
    metadataDrift.activeServerIds = ["unexpected_server"];
    expect(assessMcpRegistryAdoptionReport(metadataDrift, registry, codexConfig)).toBe("drift");

    const changedRegistry = structuredClone(registry);
    changedRegistry.servers[0]!.tools[0]!.approvalMode = "prompt";
    // Rebuilding through the authority is the supported way to obtain a new
    // fingerprint; a mutated registry is rejected before it can be assessed.
    expect(() => assessMcpRegistryAdoptionReport(report, changedRegistry, codexConfig))
      .toThrow(/fingerprint/u);
  });

  it("writes and validates a private atomic report", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-mcp-adoption-"));
    await chmod(root, 0o700);
    try {
      const { authority, registry, codexConfig } = await fixture();
      const report = createMcpRegistryAdoptionReport({
        effectiveFingerprint: authority.effectiveFingerprint,
        registry,
        codexConfig,
      });
      const path = await writeMcpRegistryAdoptionReport(root, report);
      expect((await readMcpRegistryAdoptionReport(root))?.reportFingerprint)
        .toBe(report.reportFingerprint);
      if (process.platform !== "win32") {
        expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
        expect((await stat(path)).mode & 0o777).toBe(0o600);
      }

      const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      parsed.registryFingerprint = "0".repeat(64);
      await writeFile(path, `${JSON.stringify(parsed)}\n`, "utf8");
      await expect(readMcpRegistryAdoptionReport(root)).rejects.toThrow(/fingerprint/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
