import { lstat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { readCodexCutoverReport } from "../config/adoption/codex-controlled-cutover.js";

export interface CodexNativeMemoryConfigView {
  enabled: boolean;
  use_memories: boolean;
  generate_memories: boolean;
  disable_on_external_context: boolean;
}

export interface CodexNativeMemoryRuntimeStatus {
  configured: boolean;
  useMemories: boolean;
  generateMemories: boolean;
  disableOnExternalContext: boolean;
  control: "config";
  scope: "codex-home";
  activeConfig: "unified" | "legacy" | "none" | "unknown";
  effective: boolean;
  storage: "present" | "absent";
  memoryIndex: "present" | "absent";
  rawMemories: "present" | "absent";
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
  const memoriesDir = join(codexHome, "memories");
  const cutover = await readCodexCutoverReport(repositoryRoot).catch(() => undefined);
  const activeConfig = cutover?.activeConfig ?? "unknown";

  return {
    configured: input.config.enabled,
    useMemories: input.config.use_memories,
    generateMemories: input.config.generate_memories,
    disableOnExternalContext: input.config.disable_on_external_context,
    control: "config",
    scope: "codex-home",
    activeConfig,
    effective: Boolean(
      input.config.enabled
      && cutover?.status === "active"
      && cutover.activeConfig === "unified"
      && !cutover.fallbackUsed
    ),
    storage: await exists(memoriesDir) ? "present" : "absent",
    memoryIndex: await exists(join(memoriesDir, "MEMORY.md")) ? "present" : "absent",
    rawMemories: await exists(join(memoriesDir, "raw_memories.md")) ? "present" : "absent",
  };
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
    `codex_memory_storage=${status.storage}`,
    `codex_memory_index=${status.memoryIndex}`,
    `codex_memory_raw=${status.rawMemories}`,
  ];
}

export function parseCodexMemoriesFeatureList(
  text: string,
): { status: "enabled" | "disabled" | "unavailable"; stage?: string } {
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

function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, () => false);
}
