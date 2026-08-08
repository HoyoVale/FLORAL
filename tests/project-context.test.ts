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
  inspectProjectContext,
} from "../src/workspace/project-context.js";
import { ProjectWorkspaceRoot } from "../src/workspace/project-workspace.js";

describe("project shared context bootstrap", () => {
  it("creates bounded AGENTS guidance plus read-mostly .floral context for a new project", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-context-new-"));
    try {
      const workspace = new ProjectWorkspaceRoot(root);
      await workspace.initialize();
      const project = await workspace.createProject("ScratchProbe");

      await expect(inspectProjectContext(project)).resolves.toEqual({
        initialized: true,
        activeInstructionFile: "AGENTS.md",
        instructionLinked: true,
        contextPresent: true,
        decisionsPresent: true,
        knownIssuesPresent: true,
      });

      const agents = await readFile(join(project.path, "AGENTS.md"), "utf8");
      expect(agents).toContain("FLORAL project: ScratchProbe");
      expect(agents).toContain("FLORAL:PROJECT-CONTEXT:BEGIN");
      expect(agents).toContain(".floral/CONTEXT.md");
      expect(agents).toContain("do not modify them unless the user explicitly asks");

      const context = await readFile(
        join(project.path, ".floral", "CONTEXT.md"),
        "utf8",
      );
      expect(context).toContain("Project: ScratchProbe");
      expect(context).toContain("No shared context recorded yet");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves an existing AGENTS.md and links the managed block exactly once", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-context-existing-"));
    try {
      await mkdir(join(root, "Existing"));
      await writeFile(
        join(root, "Existing", "AGENTS.md"),
        "# Existing rules\n\n- Keep this exact rule.\n",
      );
      const workspace = new ProjectWorkspaceRoot(root);
      await workspace.initialize();
      const project = await workspace.resolveExistingProject("Existing");

      const first = await bootstrapProjectContext(project);
      expect(first.instructionAction).toBe("linked");
      expect(first.changed).toBe(true);

      const second = await bootstrapProjectContext(project);
      expect(second.instructionAction).toBe("unchanged");
      expect(second.changed).toBe(false);

      const agents = await readFile(join(project.path, "AGENTS.md"), "utf8");
      expect(agents).toContain("- Keep this exact rule.");
      expect(agents.match(/FLORAL:PROJECT-CONTEXT:BEGIN/gu)).toHaveLength(1);
      expect(agents.match(/FLORAL:PROJECT-CONTEXT:END/gu)).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("links an existing AGENTS.override.md instead of writing an ignored AGENTS block", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-context-override-"));
    try {
      await mkdir(join(root, "OverrideProject"));
      await writeFile(
        join(root, "OverrideProject", "AGENTS.md"),
        "# Base rules\n",
      );
      await writeFile(
        join(root, "OverrideProject", "AGENTS.override.md"),
        "# Active override\n",
      );
      const workspace = new ProjectWorkspaceRoot(root);
      await workspace.initialize();
      const project = await workspace.resolveExistingProject("OverrideProject");

      const result = await bootstrapProjectContext(project);
      expect(result.status.activeInstructionFile).toBe("AGENTS.override.md");
      expect(result.status.instructionLinked).toBe(true);

      const base = await readFile(join(project.path, "AGENTS.md"), "utf8");
      const override = await readFile(
        join(project.path, "AGENTS.override.md"),
        "utf8",
      );
      expect(base).toBe("# Base rules\n");
      expect(override).toContain("# Active override");
      expect(override).toContain("FLORAL:PROJECT-CONTEXT:BEGIN");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed on malformed managed markers without replacing existing files", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-context-malformed-"));
    try {
      await mkdir(join(root, "Broken"));
      const agentsPath = join(root, "Broken", "AGENTS.md");
      const original = [
        "# Existing",
        "",
        "<!-- FLORAL:PROJECT-CONTEXT:BEGIN -->",
        "unfinished",
        "",
      ].join("\n");
      await writeFile(agentsPath, original);
      const workspace = new ProjectWorkspaceRoot(root);
      await workspace.initialize();
      const project = await workspace.resolveExistingProject("Broken");

      await expect(bootstrapProjectContext(project))
        .rejects.toThrow(/markers are malformed/u);
      await expect(readFile(agentsPath, "utf8")).resolves.toBe(original);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
