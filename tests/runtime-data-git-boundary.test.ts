import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("runtime data Git boundary", () => {
  it("never tracks runtime-generated data", async () => {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-files", "--", "data", "artifacts", "logs", ".codex-schemas", ".agents/skill-drafts"],
      { cwd: process.cwd() },
    );

    expect(stdout.trim()).toBe("");
  });
});
