import { lstat, mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
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

  it("lazily creates a private artifact staging root only for a managed project", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-workspace-artifacts-"));
    const outside = await mkdtemp(join(tmpdir(), "floral-workspace-outside-"));
    try {
      await mkdir(join(root, "Managed"));
      const workspace = new ProjectWorkspaceRoot(root);
      await workspace.initialize();

      const outbound = await workspace.ensureProjectArtifactOutboundRoot(
        join(root, "Managed"),
      );
      expect(outbound).toBe(await realpath(join(root, "Managed", "artifacts", "outbound")));
      expect((await lstat(outbound)).isDirectory()).toBe(true);
      await expect(workspace.ensureProjectArtifactOutboundRoot(outside))
        .rejects.toThrow(/managed direct-child project/ui);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses symlinked artifact staging directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "floral-workspace-artifact-link-"));
    const outside = await mkdtemp(join(tmpdir(), "floral-workspace-artifact-target-"));
    try {
      await mkdir(join(root, "Managed"));
      await symlink(outside, join(root, "Managed", "artifacts"), "dir");
      const workspace = new ProjectWorkspaceRoot(root);
      await workspace.initialize();

      await expect(workspace.ensureProjectArtifactOutboundRoot(join(root, "Managed")))
        .rejects.toThrow(/real directory/ui);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects hidden, relative, and separator-bearing project names", () => {
    expect(() => normalizeProjectName(".")).toThrow();
    expect(() => normalizeProjectName(".." )).toThrow();
    expect(() => normalizeProjectName(".secret")).toThrow();
    expect(() => normalizeProjectName("a/b")).toThrow();
    expect(() => normalizeProjectName("a\\b")).toThrow();
  });
});
