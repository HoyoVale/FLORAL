import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const skillPath = fileURLToPath(new URL("../skills/macos-ui-operation/SKILL.md", import.meta.url));

describe("macos-ui-operation Skill", () => {
  it("routes deterministic app operations through terminal/native CLI before GUI fallback", async () => {
    const text = await readFile(skillPath, "utf8");
    expect(text).toContain("Terminal / native CLI / documented application CLI");
    expect(text).toContain('open -a "Visual Studio Code"');
    expect(text).toContain("GUI-only fallback");
    expect(text.indexOf("Terminal / native CLI / documented application CLI"))
      .toBeLessThan(text.indexOf("GUI-only fallback"));
    expect(text).toContain("AppleScript");
    expect(text).toContain("cliclick");
    expect(text).toContain("floral_peekaboo/see");
    expect(text).toContain("floral_peekaboo/click");
  });
});
