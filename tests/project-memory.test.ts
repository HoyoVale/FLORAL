import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bootstrapProjectContext,
  inspectProjectMemory,
  recordProjectMemory,
} from "../src/workspace/project-context.js";

describe("project durable memory", () => {
  it("records explicit owner-grade entries deterministically and deduplicates exact content", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-project-memory-"));
    const projectDir = join(root, "Probe");
    await mkdir(projectDir);
    const project = { name: "Probe", path: projectDir };

    try {
      await bootstrapProjectContext(project);
      const first = await recordProjectMemory(
        project,
        "context",
        "  Windows 端修改，Mac 端只 git pull。  ",
        new Date("2026-08-08T14:00:00.000Z"),
      );
      expect(first).toMatchObject({
        changed: true,
        duplicate: false,
        kind: "context",
        entryCount: 1,
      });

      const duplicate = await recordProjectMemory(
        project,
        "context",
        "Windows 端修改，Mac 端只 git pull。",
        new Date("2026-08-08T15:00:00.000Z"),
      );
      expect(duplicate).toMatchObject({
        changed: false,
        duplicate: true,
        entryCount: 1,
      });
      expect(duplicate.fingerprint).toBe(first.fingerprint);

      await recordProjectMemory(
        project,
        "decision",
        "Execution permissions follow Codex-native policy.",
        new Date("2026-08-08T14:01:00.000Z"),
      );
      await recordProjectMemory(
        project,
        "issue",
        "Named permission profiles are not exposed by the installed Codex release.",
        new Date("2026-08-08T14:02:00.000Z"),
      );

      const status = await inspectProjectMemory(project);
      expect(status).toMatchObject({
        contextEntries: 1,
        decisionEntries: 1,
        issueEntries: 1,
      });

      const context = await readFile(join(projectDir, ".floral", "CONTEXT.md"), "utf8");
      expect(context).toContain("2026-08-08T14:00:00.000Z");
      expect(context).toContain("Windows 端修改，Mac 端只 git pull。");
      expect(context.match(/FLORAL:MEM:/gu)).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed on oversized entries and malformed managed-memory markers", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-project-memory-guard-"));
    const projectDir = join(root, "Probe");
    await mkdir(projectDir);
    const project = { name: "Probe", path: projectDir };

    try {
      await bootstrapProjectContext(project);
      await expect(recordProjectMemory(
        project,
        "context",
        "x".repeat(1_201),
      )).rejects.toThrow(/exceeds 1200 characters/u);

      const contextPath = join(projectDir, ".floral", "CONTEXT.md");
      await writeFile(
        contextPath,
        `${await readFile(contextPath, "utf8")}\n<!-- FLORAL:PROJECT-MEMORY:BEGIN -->\n`,
      );
      await expect(recordProjectMemory(
        project,
        "context",
        "must not be written",
      )).rejects.toThrow(/project-memory markers are malformed/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
