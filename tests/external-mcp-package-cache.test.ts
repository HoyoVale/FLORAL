import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ExternalMcpPackageCache } from "../src/extensions/external-mcp-package-cache.js";
import {
  CURATED_EXTERNAL_MCP,
  EXTERNAL_MCP_REGISTRY_VERSION,
} from "../src/extensions/external-mcp-registry.js";

describe("ExternalMcpPackageCache", () => {
  it("materializes a pinned package once and replaces a tampered cache atomically", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-mcp-cache-"));
    const catalog = CURATED_EXTERNAL_MCP["chrome-devtools"];
    const runtimePackage = catalog.runtimePackage!;
    let installs = 0;
    const cache = new ExternalMcpPackageCache({
      repositoryRoot: root,
      dataDir: "./data",
      install: async (directory) => {
        installs += 1;
        const packageRoot = join(directory, "node_modules", runtimePackage.name);
        const entrypoint = join(packageRoot, "build", "src", "bin.js");
        await mkdir(join(packageRoot, "build", "src"), { recursive: true });
        await writeFile(join(packageRoot, "package.json"), JSON.stringify({
          name: runtimePackage.name,
          version: runtimePackage.version,
        }), "utf8");
        await writeFile(entrypoint, `console.log(${JSON.stringify(installs)});\n`, "utf8");
        await writeFile(join(directory, "package-lock.json"), JSON.stringify({
          packages: {
            [`node_modules/${runtimePackage.name}`]: {
              version: runtimePackage.version,
              integrity: runtimePackage.integrity,
            },
          },
        }), "utf8");
      },
    });
    const registry = {
      version: EXTERNAL_MCP_REGISTRY_VERSION,
      packages: [{
        id: "chrome-devtools" as const,
        enabled: true,
        installedAt: "2026-08-11T00:00:00.000Z",
        updatedAt: "2026-08-11T00:00:00.000Z",
      }],
    };

    try {
      await cache.reconcile(registry);
      await cache.reconcile(registry);
      expect(installs).toBe(1);

      const entrypoint = join(
        root,
        "data",
        "external-extensions",
        "packages",
        "chrome-devtools",
        runtimePackage.entrypoint,
      );
      await writeFile(entrypoint, "tampered\n", "utf8");
      await cache.reconcile(registry);
      expect(installs).toBe(2);
      await expect(readFile(entrypoint, "utf8")).resolves.toContain("console.log(2)");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
