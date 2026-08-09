import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const skillPath = fileURLToPath(
  new URL("../skills/extension-manager/SKILL.md", import.meta.url),
);

describe("extension-manager Skill", () => {
  it("keeps Plugin handoff separate while giving MCP a verified managed lifecycle", async () => {
    const text = await readFile(skillPath, "utf8");
    expect(text).toContain("floral_extensions");
    expect(text).toContain("github-readonly");
    expect(text).toContain("chrome-devtools");
    expect(text).toContain("GITHUB_PAT_TOKEN");
    expect(text).toContain("status=ready");
    expect(text).toContain("Codex CLI `/plugins` browser");
    expect(text).toContain("Do not call App Server `plugin/list`");
    expect(text).toContain("do not ask the user to paste the secret into chat");
  });
});
