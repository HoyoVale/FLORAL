import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  CODEX_MODEL_CATALOG_RUNTIME_FILENAME,
  materializeCodexModelCatalogPath,
} from "../config/codex/codex-model-catalog.js";

export interface ManagedWorkspace {
  codexHome: string;
  replaceConfig?(config: string): Promise<void>;
  cleanup(): Promise<void>;
}

export interface ProjectRuntimeScope {
  key: string;
  projectPath: string;
  codexHome: string;
  inboundRoot: string;
}

export const FLORAL_PROJECT_PERMISSION_PROFILE = "floral-project";

export function scopeCodexConfigForProject(
  config: string,
  globalInboundRoot: string,
  scope: ProjectRuntimeScope,
  sharedSkillRoots: readonly string[],
  externalSkillPackagesRoot: string,
): string {
  const globalAssignment =
    `FLORAL_VISION_INBOUND_ROOT = ${JSON.stringify(globalInboundRoot)}`;
  const projectAssignment =
    `FLORAL_VISION_INBOUND_ROOT = ${JSON.stringify(scope.inboundRoot)}`;
  const visionScoped = config.includes(globalAssignment)
    ? config.replace(globalAssignment, projectAssignment)
    : config;

  const profileHeader = `[permissions.${FLORAL_PROJECT_PERMISSION_PROFILE}]`;
  if (visionScoped.includes(profileHeader)) {
    throw new Error("Project Codex config already defines the FLORAL permission profile");
  }

  return `${visionScoped.trimEnd()}\n\n${renderProjectPermissionProfile(
    scope,
    sharedSkillRoots,
    externalSkillPackagesRoot,
  )}\n`;
}

function renderProjectPermissionProfile(
  scope: ProjectRuntimeScope,
  sharedSkillRoots: readonly string[],
  externalSkillPackagesRoot: string,
): string {
  const readableSkillRoots = uniqueAbsolutePaths(
    sharedSkillRoots.length > 0
      ? sharedSkillRoots
      : [resolve(process.cwd(), "skills")],
  );
  return [
    `[permissions.${FLORAL_PROJECT_PERMISSION_PROFILE}]`,
    'description = "FLORAL project-isolated filesystem profile"',
    "",
    `[permissions.${FLORAL_PROJECT_PERMISSION_PROFILE}.filesystem]`,
    '":minimal" = "read"',
    ...readableSkillRoots.map((root) => `${JSON.stringify(root)} = "read"`),
    `${JSON.stringify(resolve(externalSkillPackagesRoot))} = "read"`,
    `${JSON.stringify(scope.inboundRoot)} = "read"`,
    "",
    `[permissions.${FLORAL_PROJECT_PERMISSION_PROFILE}.filesystem.":workspace_roots"]`,
    '"." = "write"',
    "",
    `[permissions.${FLORAL_PROJECT_PERMISSION_PROFILE}.network]`,
    "enabled = false",
  ].join("\n");
}

export function uniqueAbsolutePaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map((path) => resolve(path)))];
}

export async function createPersistentCodexWorkspace(
  codexHome: string,
  config: string,
  options: {
    fallbackConfig?: string | undefined;
    modelCatalog?: string | undefined;
  } = {},
): Promise<ManagedWorkspace> {
  const resolvedHome = resolve(codexHome);
  const configPath = resolve(resolvedHome, "config.toml");
  const fallbackPath = resolve(resolvedHome, "config.legacy-fallback.toml");
  const modelCatalogPath = resolve(resolvedHome, CODEX_MODEL_CATALOG_RUNTIME_FILENAME);
  const materializeConfig = (value: string): string =>
    materializeCodexModelCatalogPath(value, modelCatalogPath);

  await mkdir(resolvedHome, { recursive: true, mode: 0o700 });
  await chmod(resolvedHome, 0o700).catch(() => undefined);
  if (options.modelCatalog) {
    await writeAtomicPrivateText(modelCatalogPath, options.modelCatalog);
  } else {
    await rm(modelCatalogPath, { force: true });
  }
  if (options.fallbackConfig) {
    await writeAtomicPrivateText(fallbackPath, materializeConfig(options.fallbackConfig));
  } else {
    await rm(fallbackPath, { force: true });
  }
  await writeAtomicPrivateText(configPath, materializeConfig(config));

  return {
    codexHome: resolvedHome,
    replaceConfig: async (replacement) => {
      await writeAtomicPrivateText(configPath, materializeConfig(replacement));
    },
    cleanup: async () => {
      // Keep Codex thread/session state across FLORAL restarts, but remove the
      // short-lived bridge URL/token configuration and rollback copy once this
      // process stops.
      await Promise.all([
        rm(configPath, { force: true }),
        rm(fallbackPath, { force: true }),
        rm(modelCatalogPath, { force: true }),
      ]);
    },
  };
}

async function writeAtomicPrivateText(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
  const temporary = `${path}.tmp-${String(process.pid)}-${Date.now().toString(36)}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await chmod(temporary, 0o600).catch(() => undefined);
    await rename(temporary, path);
    await chmod(path, 0o600).catch(() => undefined);
    await syncDirectory(directory);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is not portable to every Windows filesystem. The file
    // itself has already been synced before the atomic rename.
  }
}
