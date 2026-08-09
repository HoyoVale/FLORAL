import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CHROME_DEVTOOLS_MCP_VERSION,
  CURATED_EXTERNAL_MCP,
  EXTERNAL_MCP_REGISTRY_VERSION,
  renderExternalMcpOverlay,
  resolveExternalMcpRegistryPaths,
  writeExternalMcpRegistry,
} from "../src/extensions/external-mcp-registry.js";
import { ExternalMcpHostManager } from "../src/extensions/external-mcp-manager.js";

describe("External MCP registry", () => {
  it("renders GitHub as the official read-only remote endpoint without storing secret values", () => {
    const config = renderExternalMcpOverlay("model = \"fake\"\n", {
      version: EXTERNAL_MCP_REGISTRY_VERSION,
      packages: [{
        id: "github-readonly",
        enabled: true,
        installedAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T00:00:00.000Z",
      }],
    });
    expect(config).toContain("[mcp_servers.github]");
    expect(config).toContain('url = "https://api.githubcopilot.com/mcp/readonly"');
    expect(config).toContain('bearer_token_env_var = "GITHUB_PAT_TOKEN"');
    expect(config).toContain('default_tools_approval_mode = "auto"');
    expect(config).not.toContain("ghp_");
  });

  it("pins Chrome DevTools MCP and asks Codex to prompt only on writes", () => {
    const config = renderExternalMcpOverlay("model = \"fake\"\n", {
      version: EXTERNAL_MCP_REGISTRY_VERSION,
      packages: [{
        id: "chrome-devtools",
        enabled: true,
        installedAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T00:00:00.000Z",
      }],
    });
    expect(CHROME_DEVTOOLS_MCP_VERSION).toBe("1.6.0");
    expect(config).toContain("[mcp_servers.chrome-devtools]");
    expect(config).toContain(`chrome-devtools-mcp@${CHROME_DEVTOOLS_MCP_VERSION}`);
    expect(config).toContain('default_tools_approval_mode = "writes"');
    expect(config).toContain('CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS = "1"');
    expect(config).toContain("--headless");
    expect(config).toContain("--no-usage-statistics");
  });

  it("keeps authentication metadata outside the machine-local registry", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-external-mcp-"));
    const paths = resolveExternalMcpRegistryPaths(root, "./data");
    try {
      await writeExternalMcpRegistry(paths, {
        version: EXTERNAL_MCP_REGISTRY_VERSION,
        packages: [{
          id: "github-readonly",
          enabled: true,
          installedAt: "2026-08-10T00:00:00.000Z",
          updatedAt: "2026-08-10T00:00:00.000Z",
        }],
      });
      const raw = await readFile(paths.registryPath, "utf8");
      expect(raw).toContain('"github-readonly"');
      expect(raw).not.toContain("GITHUB_PAT_TOKEN");
      expect(raw).not.toContain("bearer");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports GitHub auth presence without exposing the token and mutates curated entries atomically", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-external-mcp-manager-"));
    const manager = new ExternalMcpHostManager(root, "./data", {
      GITHUB_PAT_TOKEN: "secret-never-return-this",
    });
    try {
      const before = await manager.listCatalog();
      expect(before.find((entry) => entry.id === "github-readonly")).toMatchObject({
        installed: false,
        auth: "present",
        strictReadOnly: true,
      });
      expect(JSON.stringify(before)).not.toContain("secret-never-return-this");

      const installed = await manager.mutate({
        action: "install",
        id: "github-readonly",
      });
      expect(installed.changed).toBe(true);
      expect(installed.registry.packages).toHaveLength(1);
      const disabled = await manager.mutate({
        action: "disable",
        id: "github-readonly",
      });
      expect(disabled.registry.packages[0]?.enabled).toBe(false);
      const removed = await manager.mutate({
        action: "remove",
        id: "github-readonly",
      });
      expect(removed.registry.packages).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports the exact GitHub secret bootstrap requirement without exposing a credential", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-external-mcp-auth-missing-"));
    const manager = new ExternalMcpHostManager(root, "./data", {});
    try {
      const installed = await manager.mutate({
        action: "install",
        id: "github-readonly",
      });
      expect(installed.message).toContain("auth=missing");
      expect(installed.message).toContain("required_secret=GITHUB_PAT_TOKEN");
      expect(installed.message).toContain("service_restart_required_after_secret=true");
      expect(installed.message).toContain("restart_required=false");
      expect(installed.message).not.toContain("ghp_");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the curated sources fixed", () => {
    expect(CURATED_EXTERNAL_MCP["github-readonly"].supplyChain)
      .toContain("github/github-mcp-server");
    expect(CURATED_EXTERNAL_MCP["chrome-devtools"].supplyChain)
      .toContain("chrome-devtools-mcp@1.6.0");
  });
});
