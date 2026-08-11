import {
  supportsAgentThreadManagement,
  type AgentRuntime,
  type AgentThreadManagementRuntime,
  type AgentThreadSummary,
} from "../core/contracts.js";

export function requireThreadManagementRuntime(runtime: AgentRuntime): AgentThreadManagementRuntime {
  if (!supportsAgentThreadManagement(runtime)) {
    throw new Error("Managed Codex runtime does not expose thread management");
  }
  return runtime;
}

export interface CodexThreadListResponse {
  data?: Array<{
    id?: unknown;
    preview?: unknown;
    createdAt?: unknown;
    updatedAt?: unknown;
  }>;
  nextCursor?: unknown;
}

export function parseCodexThreadList(response: CodexThreadListResponse): AgentThreadSummary[] {
  const data = Array.isArray(response?.data) ? response.data : [];
  return data.flatMap((entry) => {
    const id = typeof entry?.id === "string" ? entry.id.trim() : "";
    if (!id) return [];
    const createdAt = finiteNonNegative(entry.createdAt);
    const updatedAt = finiteNonNegative(entry.updatedAt);
    return [{
      id,
      preview: sanitizePreview(entry.preview),
      ...(createdAt !== undefined ? { createdAt } : {}),
      ...(updatedAt !== undefined ? { updatedAt } : {}),
    }];
  });
}

function sanitizePreview(value: unknown): string {
  if (typeof value !== "string") return "未命名会话";
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
  return normalized ? Array.from(normalized).slice(0, 120).join("") : "未命名会话";
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
