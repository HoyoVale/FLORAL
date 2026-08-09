import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const skillPath = fileURLToPath(
  new URL("../skills/skill-manager/SKILL.md", import.meta.url),
);

describe("skill-manager Skill", () => {
  it("keeps builtin, project, and shared external Skill scopes separate", async () => {
    const text = await readFile(skillPath, "utf8");
    expect(text).toContain("<cwd>/.agents/skills/<skill-name>/SKILL.md");
    expect(text).toContain("floral_skills/set_enabled");
    expect(text).toContain("floral_skills/manage_external");
    expect(text).toContain("skills/config/write");
    expect(text).toContain("FLORAL builtin Skills are protected");
    expect(text).toContain("Do not install from arbitrary Git URLs through shell");
  });
});
