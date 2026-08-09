import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CURATED_EXTERNAL_SKILLS,
  EXTERNAL_SKILL_REGISTRY_VERSION,
  resolveExternalSkillRegistryPaths,
  writeExternalSkillRegistry,
} from "../src/skills/external-skill-registry.js";
import { ExternalSkillManager } from "../src/skills/external-skill-manager.js";

async function createSkill(root: string, name: string): Promise<void> {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: test\n---\n\n# ${name}\n`,
    "utf8",
  );
}

describe("ExternalSkillManager", () => {
  it("manages shared enable state without bypassing the validated registry", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-external-manager-"));
    const repositoryRoot = join(root, "repo");
    const dataDir = "./data";
    await createSkill(join(repositoryRoot, "skills"), "system-status");

    const paths = resolveExternalSkillRegistryPaths(repositoryRoot, dataDir);
    const externalSkillRoot = join(
      paths.packagesRoot,
      "superpowers",
      "repository",
      "skills",
    );
    await createSkill(externalSkillRoot, "brainstorming");
    await writeExternalSkillRegistry(paths, {
      version: EXTERNAL_SKILL_REGISTRY_VERSION,
      packages: [{
        id: "superpowers",
        repository: CURATED_EXTERNAL_SKILLS.superpowers.repository,
        ref: "main",
        commit: "d".repeat(40),
        enabled: true,
        skillSubdir: "skills",
        installedAt: "2026-08-09T00:00:00.000Z",
        updatedAt: "2026-08-09T00:00:00.000Z",
      }],
    });

    const manager = new ExternalSkillManager({
      repositoryRoot,
      dataDir,
    });

    try {
      await expect(manager.list()).resolves.toEqual([
        expect.objectContaining({
          id: "superpowers",
          installed: true,
          enabled: true,
        }),
      ]);
      await expect(manager.enabledRoots(true)).resolves.toHaveLength(1);

      const disabled = await manager.manage({
        action: "disable",
        id: "superpowers",
      });
      expect(disabled.changed).toBe(true);
      expect(disabled.message).toContain("external_skills.disable=ok");
      await expect(manager.enabledRoots(true)).resolves.toEqual([]);

      const enabled = await manager.manage({
        action: "enable",
        id: "superpowers",
      });
      expect(enabled.changed).toBe(true);
      expect(enabled.message).toContain("external_skills.enable=ok");
      await expect(manager.enabledRoots(true)).resolves.toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unknown shared package ids", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-external-manager-unknown-"));
    const repositoryRoot = join(root, "repo");
    await mkdir(join(repositoryRoot, "skills"), { recursive: true });
    const manager = new ExternalSkillManager({
      repositoryRoot,
      dataDir: "./data",
    });
    try {
      await expect(manager.manage({
        action: "enable",
        id: "not-curated",
      })).rejects.toThrow(/Unknown external Skill id/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
