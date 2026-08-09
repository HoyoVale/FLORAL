import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ProjectWorkspaceRoot,
  normalizeProjectName,
  projectRuntimeNamespace,
} from "../src/workspace/project-workspace.js";

describe("ProjectWorkspaceRoot", () => {
  it("lists and resolves only real direct child project directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-workspace-"));
    try {
      await mkdir(join(root, "FLORAL"));
      await mkdir(join(root, "WISTERIA"));
      await mkdir(join(root, ".hidden"));
      await mkdir(join(root, "nested", "child"), { recursive: true });

      const workspace = new ProjectWorkspaceRoot(root);
      await workspace.initialize();

      await expect(workspace.listProjects()).resolves.toEqual([
        expect.objectContaining({ name: "FLORAL" }),
        expect.objectContaining({ name: "nested" }),
        expect.objectContaining({ name: "WISTERIA" }),
      ]);
      await expect(workspace.resolveExistingProject("FLORAL"))
        .resolves.toMatchObject({ name: "FLORAL" });
      await expect(workspace.resolveExistingProject("../outside"))
        .rejects.toThrow(/hidden or relative|path separators|direct child/ui);
      await expect(workspace.resolveExistingProject("nested/child"))
        .rejects.toThrow(/path separators|direct child/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("creates only a new real direct-child project directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-workspace-create-"));
    try {
      const workspace = new ProjectWorkspaceRoot(root);
      await workspace.initialize();

      await expect(workspace.createProject("NewProject"))
        .resolves.toMatchObject({ name: "NewProject" });
      await expect(workspace.resolveExistingProject("NewProject"))
        .resolves.toMatchObject({ name: "NewProject" });
      await expect(workspace.createProject("NewProject")).rejects.toThrow();
      await expect(workspace.createProject("../escape")).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("derives a stable opaque runtime namespace from the project path", () => {
    const first = projectRuntimeNamespace("/tmp/example/project-a");
    const same = projectRuntimeNamespace("/tmp/example/project-a");
    const other = projectRuntimeNamespace("/tmp/example/project-b");
    expect(first).toMatch(/^[a-f0-9]{24}$/u);
    expect(same).toBe(first);
    expect(other).not.toBe(first);
  });

  it("rejects hidden, relative, and separator-bearing project names", () => {
    expect(() => normalizeProjectName(".")).toThrow();
    expect(() => normalizeProjectName(".." )).toThrow();
    expect(() => normalizeProjectName(".secret")).toThrow();
    expect(() => normalizeProjectName("a/b")).toThrow();
    expect(() => normalizeProjectName("a\\b")).toThrow();
  });
});
