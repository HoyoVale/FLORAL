import { chmod, cp, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfigurationAuthority } from "../src/config/federation/config-authority.js";
import {
  buildSearxngRuntimePreparationContract,
  prepareLegacySearxngRuntime,
  prepareUnifiedSearxngRuntime,
} from "../src/config/search/searxng-runtime-preparation.js";

const repositoryRoot = resolve(".");

async function createInfraFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "floral-searxng-preparation-"));
  for (const relativePath of ["infra/searxng/compose.yaml", "infra/searxng/settings.template.yml"]) {
    const destination = join(root, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(repositoryRoot, relativePath), destination);
  }
  return root;
}

describe("SearXNG runtime preparation", () => {
  it("builds a deterministic secret-free contract", async () => {
    const authority = await resolveConfigurationAuthority({ repositoryRoot, environment: {} });
    const first = buildSearxngRuntimePreparationContract(authority.effective);
    const second = buildSearxngRuntimePreparationContract(authority.effective);
    expect(first).toEqual(second);
    expect(first.image).toMatch(/^docker\.io\/searxng\/searxng@sha256:[a-f0-9]{64}$/u);
    expect(first.runtimeFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(first)).not.toContain("secret_key");
  });

  it("prepares effective settings from the unified renderer with private permissions", async () => {
    const root = await createInfraFixture();
    const authority = await resolveConfigurationAuthority({ repositoryRoot, environment: {} });
    const contract = buildSearxngRuntimePreparationContract(authority.effective);
    const prepared = await prepareUnifiedSearxngRuntime({
      repositoryRoot: root,
      config: authority.effective,
      validatedImages: [contract.image],
    });
    const settings = await readFile(prepared.settingsFile, "utf8");
    const secret = (await readFile(prepared.secretFile, "utf8")).trim();
    expect(prepared.preparation).toBe("unified");
    expect(settings).not.toContain("__FLORAL_SEARXNG_SECRET__");
    expect(settings).toContain(secret);
    expect(secret).toMatch(/^[a-f0-9]{64}$/u);
    if (process.platform !== "win32") {
      expect((await stat(prepared.settingsFile)).mode & 0o777).toBe(0o600);
      expect((await stat(prepared.secretFile)).mode & 0o777).toBe(0o600);
      expect((await stat(dirname(prepared.settingsFile))).mode & 0o777).toBe(0o700);
    }
  });

  it("fails closed when the image is not reviewed or checked-in projections drift", async () => {
    const root = await createInfraFixture();
    const authority = await resolveConfigurationAuthority({ repositoryRoot, environment: {} });
    await expect(prepareUnifiedSearxngRuntime({
      repositoryRoot: root,
      config: authority.effective,
      validatedImages: [],
    })).rejects.toThrow(/reviewed runtime compatibility catalog/u);

    await writeFile(join(root, "infra/searxng/compose.yaml"), "services: {}\n", "utf8");
    const contract = buildSearxngRuntimePreparationContract(authority.effective);
    await expect(prepareUnifiedSearxngRuntime({
      repositoryRoot: root,
      config: authority.effective,
      validatedImages: [contract.image],
    })).rejects.toThrow(/drifted from the unified renderer/u);
  });

  it("keeps the checked-in template as a legacy recovery path", async () => {
    const root = await createInfraFixture();
    const authority = await resolveConfigurationAuthority({ repositoryRoot, environment: {} });
    await chmod(join(root, "infra/searxng/settings.template.yml"), 0o600).catch(() => undefined);
    const prepared = await prepareLegacySearxngRuntime(root, authority.effective);
    expect(prepared.preparation).toBe("legacy");
    expect(await readFile(prepared.settingsFile, "utf8")).not.toContain("__FLORAL_SEARXNG_SECRET__");
  });
});
