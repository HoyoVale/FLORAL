import { createHash } from "node:crypto";
import type { AgentMcpToolApprovalScope } from "../core/types.js";

export function buildGithubMcpApprovalScope(
  serverId: string,
  toolName: string,
  argumentsValue: Record<string, unknown>,
): AgentMcpToolApprovalScope {
  return {
    type: "mcp-tool",
    serverId,
    toolName,
    argumentsDigest: `sha256:${createHash("sha256").update(canonicalJson(argumentsValue)).digest("hex")}`,
    target: githubTarget(argumentsValue),
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function githubTarget(value: Record<string, unknown>): string {
  const owner = plainText(value.owner, 100);
  const repo = plainText(value.repo, 100) ?? plainText(value.repository, 100);
  const number = value.issue_number ?? value.pull_number ?? value.run_id ?? value.workflow_id;
  const suffix = typeof number === "string" || typeof number === "number"
    ? `#${String(number).slice(0, 80)}` : "";
  return owner && repo ? `${owner}/${repo}${suffix}` : "github-account-scope";
}

function plainText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/[\u0000-\u001F\u007F]+/gu, " ").replace(/\s+/gu, " ").trim();
  return text ? Array.from(text).slice(0, max).join("") : undefined;
}
