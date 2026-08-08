import { access, lstat, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { readCodexCutoverReport } from "../config/adoption/codex-controlled-cutover.js";

export interface CodexNativeMemoryConfigView {
  enabled: boolean;
  use_memories: boolean;
  generate_memories: boolean;
  disable_on_external_context: boolean;
}

export type CodexNativeMemoryLifecycle =
  | "inactive"
  | "armed"
  | "generated"
  | "consolidated";

export interface CodexNativeMemoryRuntimeStatus {
  configured: boolean;
  useMemories: boolean;
  generateMemories: boolean;
  disableOnExternalContext: boolean;
  control: "config";
  scope: "codex-home";
  activeConfig: "unified" | "legacy" | "none" | "unknown";
  runtimeConfig: "present" | "absent";
  effective: boolean;
  storage: "present" | "absent";
  memoryIndex: "present" | "absent";
  rawMemories: "present" | "absent";
  rolloutSummaryCount: number;
  memoryIndexBytes: number;
  rawMemoriesBytes: number;
  lastArtifactAt?: string;
  lifecycle: CodexNativeMemoryLifecycle;
}

export interface CodexMemoriesFeatureProbeResult {
  status: "enabled" | "disabled" | "unavailable";
  stage?: string;
}

export async function readCodexNativeMemoryRuntimeStatus(input: {
  repositoryRoot: string;
  managedHome: string;
  config: CodexNativeMemoryConfigView;
}): Promise<CodexNativeMemoryRuntimeStatus> {
  const repositoryRoot = resolve(input.repositoryRoot);
  const codexHome = isAbsolute(input.managedHome)
    ? resolve(input.managedHome)
    : resolve(repositoryRoot, input.managedHome);
  const runtimeConfigPath = join(codexHome, "config.toml");
  const memoriesDir = join(codexHome, "memories");
  const memoryIndexPath = join(memoriesDir, "MEMORY.md");
  const rawMemoriesPath = join(memoriesDir, "raw_memories.md");
  const rolloutSummariesPath = join(memoriesDir, "rollout_summaries");
  const cutover = await readCodexCutoverReport(repositoryRoot).catch(() => undefined);
  const activeConfig = cutover?.activeConfig ?? "unknown";

  const [runtimeConfigMetadata, storageMetadata, memoryIndexMetadata, rawMemoriesMetadata, rolloutSummaryCount] =
    await Promise.all([
      readRegularFileMetadata(runtimeConfigPath),
      readPathMetadata(memoriesDir),
      readRegularFileMetadata(memoryIndexPath),
      readRegularFileMetadata(rawMemoriesPath),
      countRegularFilesBounded(rolloutSummariesPath, 512),
    ]);
  const runtimeConfig = runtimeConfigMetadata ? "present" : "absent";
  const effective = Boolean(
    input.config.enabled
    && runtimeConfig === "present"
    && cutover?.status === "active"
    && cutover.activeConfig === "unified"
    && !cutover.fallbackUsed
  );

  const lastArtifactMs = Math.max(
    memoryIndexMetadata?.mtimeMs ?? 0,
    rawMemoriesMetadata?.mtimeMs ?? 0,
  );
  const memoryIndex = memoryIndexMetadata ? "present" : "absent";
  const rawMemories = rawMemoriesMetadata ? "present" : "absent";

  return {
    configured: input.config.enabled,
    useMemories: input.config.use_memories,
    generateMemories: input.config.generate_memories,
    disableOnExternalContext: input.config.disable_on_external_context,
    control: "config",
    scope: "codex-home",
    activeConfig,
    runtimeConfig,
    effective,
    storage: storageMetadata ? "present" : "absent",
    memoryIndex,
    rawMemories,
    rolloutSummaryCount,
    memoryIndexBytes: memoryIndexMetadata?.size ?? 0,
    rawMemoriesBytes: rawMemoriesMetadata?.size ?? 0,
    ...(lastArtifactMs > 0 ? { lastArtifactAt: new Date(lastArtifactMs).toISOString() } : {}),
    lifecycle: classifyCodexNativeMemoryLifecycle({
      effective,
      memoryIndex,
      rawMemories,
      rolloutSummaryCount,
    }),
  };
}

export function classifyCodexNativeMemoryLifecycle(input: {
  effective: boolean;
  memoryIndex: "present" | "absent";
  rawMemories: "present" | "absent";
  rolloutSummaryCount: number;
}): CodexNativeMemoryLifecycle {
  if (!input.effective) return "inactive";
  if (input.memoryIndex === "present") return "consolidated";
  if (input.rawMemories === "present" || input.rolloutSummaryCount > 0) return "generated";
  return "armed";
}

export function renderCodexNativeMemoryRuntimeLines(
  status: CodexNativeMemoryRuntimeStatus,
): string[] {
  return [
    `codex_memory=${status.effective ? "enabled" : status.configured ? "configured-not-active" : "disabled"}`,
    `codex_memory_use=${String(status.useMemories)}`,
    `codex_memory_generate=${String(status.generateMemories)}`,
    `codex_memory_external_context=${status.disableOnExternalContext ? "disable" : "allow"}`,
    `codex_memory_control=${status.control}`,
    `codex_memory_scope=${status.scope}`,
    `codex_memory_active_config=${status.activeConfig}`,
    `codex_memory_runtime_config=${status.runtimeConfig}`,
    `codex_memory_lifecycle=${status.lifecycle}`,
    `codex_memory_storage=${status.storage}`,
    `codex_memory_index=${status.memoryIndex}`,
    `codex_memory_raw=${status.rawMemories}`,
    `codex_memory_rollout_summaries=${String(status.rolloutSummaryCount)}`,
    `codex_memory_index_bytes=${String(status.memoryIndexBytes)}`,
    `codex_memory_raw_bytes=${String(status.rawMemoriesBytes)}`,
    `codex_memory_last_artifact_at=${status.lastArtifactAt ?? "none"}`,
  ];
}

export function parseCodexMemoriesFeatureList(
  text: string,
): CodexMemoriesFeatureProbeResult {
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line.startsWith("memories")) continue;
    const parts = line.split(/\s+/u);
    if (parts[0] !== "memories" || parts.length < 3) continue;
    const enabled = parts.at(-1);
    const stage = parts.slice(1, -1).join(" ") || undefined;
    if (enabled === "true") {
      return { status: "enabled", ...(stage ? { stage } : {}) };
    }
    if (enabled === "false") {
      return { status: "disabled", ...(stage ? { stage } : {}) };
    }
  }
  return { status: "unavailable" };
}

export async function resolveCodexExecutableForProbe(input: {
  command: string;
  pathValue?: string | undefined;
  homeDir?: string | undefined;
}): Promise<string | undefined> {
  const command = input.command.trim();
  if (!command) return undefined;
  const pathValue = input.pathValue ?? process.env.PATH ?? "";
  const homeDir = input.homeDir ?? homedir();
  const candidates: string[] = [];

  if (command.includes("/") || isAbsolute(command)) {
    candidates.push(resolve(command));
  } else {
    for (const directory of pathValue.split(delimiter).filter(Boolean)) {
      candidates.push(resolve(directory, command));
    }
    if (command === "codex") {
      candidates.push(
        join(homeDir, ".local", "bin", "codex"),
        join(homeDir, ".codex", "packages", "standalone", "current", "bin", "codex"),
      );
    }
  }

  for (const candidate of [...new Set(candidates)]) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue searching without leaking the full candidate set into diagnostics.
    }
  }
  return undefined;
}

async function readPathMetadata(path: string): Promise<{ mtimeMs: number } | undefined> {
  try {
    const metadata = await lstat(path);
    return { mtimeMs: metadata.mtimeMs };
  } catch {
    return undefined;
  }
}

async function readRegularFileMetadata(
  path: string,
): Promise<{ size: number; mtimeMs: number } | undefined> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile()) return undefined;
    return { size: metadata.size, mtimeMs: metadata.mtimeMs };
  } catch {
    return undefined;
  }
}

async function countRegularFilesBounded(path: string, limit: number): Promise<number> {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  let count = 0;
  for (const entry of entries) {
    if (entry.isFile()) count += 1;
    if (count >= limit) return limit;
  }
  return count;
}
