import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CURATED_EXTERNAL_SKILLS,
  EXTERNAL_SKILL_REGISTRY_VERSION,
  resolveEnabledExternalSkillRoots,
  resolveExternalSkillRegistryPaths,
  validateExternalSkillCheckout,
  writeExternalSkillRegistry,
} from "../src/skills/external-skill-registry.js";

async function createSkill(root: string, name: string): Promise<void> {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: test\n---\n\n# ${name}\n`,
    "utf8",
  );
}

describe("external Skill registry", () => {
  it("resolves an enabled curated Skill checkout as a Codex extra root", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-external-skills-"));
    const repositoryRoot = join(root, "repo");
    const dataDir = "./data";
    await mkdir(join(repositoryRoot, "skills"), { recursive: true });
    const paths = resolveExternalSkillRegistryPaths(repositoryRoot, dataDir);
    const checkout = join(paths.packagesRoot, "superpowers", "repository");
    const skillRoot = join(checkout, "skills");
    await createSkill(skillRoot, "brainstorming");
    await writeExternalSkillRegistry(paths, {
      version: EXTERNAL_SKILL_REGISTRY_VERSION,
      packages: [{
        id: "superpowers",
        repository: CURATED_EXTERNAL_SKILLS.superpowers.repository,
        ref: "main",
        commit: "a".repeat(40),
        enabled: true,
        skillSubdir: "skills",
        installedAt: "2026-08-09T00:00:00.000Z",
        updatedAt: "2026-08-09T00:00:00.000Z",
      }],
    });

    try {
      await expect(resolveEnabledExternalSkillRoots({
        repositoryRoot,
        dataDir,
        strict: true,
      })).resolves.toEqual([expect.stringMatching(/[\\/]skills$/u)]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not expose disabled external Skills", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-external-skills-disabled-"));
    const repositoryRoot = join(root, "repo");
    await mkdir(join(repositoryRoot, "skills"), { recursive: true });
    const paths = resolveExternalSkillRegistryPaths(repositoryRoot, "./data");
    const skillRoot = join(paths.packagesRoot, "superpowers", "repository", "skills");
    await createSkill(skillRoot, "brainstorming");
    await writeExternalSkillRegistry(paths, {
      version: EXTERNAL_SKILL_REGISTRY_VERSION,
      packages: [{
        id: "superpowers",
        repository: CURATED_EXTERNAL_SKILLS.superpowers.repository,
        ref: "main",
        commit: "b".repeat(40),
        enabled: false,
        skillSubdir: "skills",
        installedAt: "2026-08-09T00:00:00.000Z",
        updatedAt: "2026-08-09T00:00:00.000Z",
      }],
    });

    try {
      await expect(resolveEnabledExternalSkillRoots({
        repositoryRoot,
        dataDir: "./data",
        strict: true,
      })).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an external Skill that collides with a FLORAL built-in Skill name", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-external-skills-collision-"));
    const repositoryRoot = join(root, "repo");
    await createSkill(join(repositoryRoot, "skills"), "system-status");
    const paths = resolveExternalSkillRegistryPaths(repositoryRoot, "./data");
    const skillRoot = join(paths.packagesRoot, "superpowers", "repository", "skills");
    await createSkill(skillRoot, "system-status");
    await writeExternalSkillRegistry(paths, {
      version: EXTERNAL_SKILL_REGISTRY_VERSION,
      packages: [{
        id: "superpowers",
        repository: CURATED_EXTERNAL_SKILLS.superpowers.repository,
        ref: "main",
        commit: "c".repeat(40),
        enabled: true,
        skillSubdir: "skills",
        installedAt: "2026-08-09T00:00:00.000Z",
        updatedAt: "2026-08-09T00:00:00.000Z",
      }],
    });

    try {
      await expect(resolveEnabledExternalSkillRoots({
        repositoryRoot,
        dataDir: "./data",
        strict: true,
      })).rejects.toThrow(/Skill name collision/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects symlinks inside a curated external Skill tree", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "floral-external-skills-symlink-"));
    const checkout = join(root, "checkout");
    const skillRoot = join(checkout, "skills");
    await createSkill(skillRoot, "brainstorming");
    await symlink("/tmp", join(skillRoot, "brainstorming", "escape"));
    try {
      await expect(validateExternalSkillCheckout(checkout, "skills"))
        .rejects.toThrow(/symlink is forbidden/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
