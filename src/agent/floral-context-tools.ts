import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type {
  AgentApprovalHandler,
  AgentApprovalRequest,
} from "../core/types.js";
import {
  inspectProjectContext,
  inspectProjectMemory,
  readProjectMemoryDocument,
  recordProjectMemory,
  verifyProjectMemoryLedgerEntry,
  type ProjectMemoryKind,
} from "../workspace/project-context.js";
import { listProjectContextLedgerEntries } from "../workspace/project-context-ledger.js";

interface ContextProposal {
  id: string;
  target: ProjectMemoryKind;
  text: string;
  evidenceRefs: string[];
}

export interface FloralContextToolResult {
  success: boolean;
  text: string;
}

export interface FloralContextToolCall {
  threadId: string;
  cwd: string;
  tool: string;
  callId: string;
  arguments: Record<string, unknown>;
  approvalHandler?: AgentApprovalHandler | undefined;
  onApprovalRequested?: ((request: AgentApprovalRequest) => void) | undefined;
}

export const FLORAL_CONTEXT_DYNAMIC_TOOLS = [
  {
    type: "namespace",
    name: "floral_context",
    description: "FLORAL-governed project context management. Context bodies stay in project files; provenance records contain hashes and bounded evidence references only. Never edit AGENTS.md or .floral files through shell redirection.",
    tools: [
      {
        type: "function",
        name: "status",
        description: "Read the current project's shared-context readiness, managed-entry counts, and provenance-ledger summary.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        deferLoading: false,
      },
      {
        type: "function",
        name: "read",
        description: "Read one bounded project context document through FLORAL's path and file-integrity checks.",
        inputSchema: {
          type: "object",
          properties: { target: { type: "string", enum: ["context", "decision", "issue"] } },
          required: ["target"],
          additionalProperties: false,
        },
        deferLoading: false,
      },
      {
        type: "function",
        name: "propose_update",
        description: "Create a turn-bound proposal to append one concise context, decision, or known-issue entry. This does not write a project file.",
        inputSchema: {
          type: "object",
          properties: {
            target: { type: "string", enum: ["context", "decision", "issue"] },
            text: { type: "string", minLength: 1, maxLength: 1200 },
            evidence_refs: {
              type: "array",
              minItems: 0,
              maxItems: 16,
              items: { type: "string", minLength: 1, maxLength: 160 },
            },
          },
          required: ["target", "text"],
          additionalProperties: false,
        },
        deferLoading: false,
      },
      {
        type: "function",
        name: "apply_update",
        description: "Apply one current-turn proposal only after FLORAL's existing owner-scoped file-change approval. The write is limited to the selected project's managed .floral document and creates a provenance receipt.",
        inputSchema: {
          type: "object",
          properties: { proposal_id: { type: "string", minLength: 1, maxLength: 80 } },
          required: ["proposal_id"],
          additionalProperties: false,
        },
        deferLoading: false,
      },
      {
        type: "function",
        name: "verify",
        description: "Verify that one ledger receipt still has its corresponding managed entry in the project document. Does not read or return arbitrary paths.",
        inputSchema: {
          type: "object",
          properties: { ledger_entry_id: { type: "string", pattern: "^[a-f0-9]{32}$" } },
          required: ["ledger_entry_id"],
          additionalProperties: false,
        },
        deferLoading: false,
      },
      {
        type: "function",
        name: "history",
        description: "List bounded provenance metadata for project context entries without returning their body text.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        deferLoading: false,
      },
      {
        type: "function",
        name: "compact",
        description: "Report the context-compaction lifecycle. Automatic rewriting is intentionally deferred until Phase 8G's durable transaction journal exists.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        deferLoading: false,
      },
    ],
  },
] as const;

export class FloralContextToolController {
  readonly #proposals = new Map<string, Map<string, ContextProposal>>();

  clear(): void {
    this.#proposals.clear();
  }

  clearThread(threadId: string): void {
    this.#proposals.delete(threadId);
  }

  async handle(call: FloralContextToolCall): Promise<FloralContextToolResult> {
    const project = { name: basename(call.cwd), path: call.cwd };
    try {
      if (call.tool === "status") {
        const [context, memory, ledger] = await Promise.all([
          inspectProjectContext(project),
          inspectProjectMemory(project),
          listProjectContextLedgerEntries(project),
        ]);
        return ok([
          `context_initialized=${String(context.initialized)}`,
          `instruction_file=${context.activeInstructionFile ?? "none"}`,
          `instruction_linked=${String(context.instructionLinked)}`,
          `context_entries=${String(memory.contextEntries)}`,
          `decision_entries=${String(memory.decisionEntries)}`,
          `issue_entries=${String(memory.issueEntries)}`,
          `ledger_entries=${String(ledger.length)}`,
          "agents_managed_block=bootstrap-only",
          "compaction=deferred-durable-journal-required",
        ].join("\n"));
      }

      if (call.tool === "read") {
        const target = readProjectContextTarget(call.arguments.target);
        if (!target) throw new Error("invalid context target");
        const content = await readProjectMemoryDocument(project, target);
        return ok([
          `target=${target}`,
          "content_begin",
          boundedToolText(content),
          "content_end",
        ].join("\n"));
      }

      if (call.tool === "propose_update") {
        const target = readProjectContextTarget(call.arguments.target);
        const text = readProjectContextText(call.arguments.text);
        const evidenceRefs = readProjectContextEvidenceRefs(call.arguments.evidence_refs);
        if (!target || !text || !evidenceRefs) throw new Error("invalid context proposal");
        const id = `ctx-${randomUUID().replace(/-/gu, "").slice(0, 20)}`;
        const proposals = this.#proposals.get(call.threadId) ?? new Map<string, ContextProposal>();
        proposals.set(id, { id, target, text, evidenceRefs });
        this.#proposals.set(call.threadId, proposals);
        return ok([
          "context_proposal=created",
          `proposal_id=${id}`,
          `target=${target}`,
          `character_count=${String(text.length)}`,
          `evidence_refs=${String(evidenceRefs.length)}`,
          "next=apply_update",
        ].join("\n"));
      }

      if (call.tool === "apply_update") {
        const proposalId = readContextProposalId(call.arguments.proposal_id);
        const proposal = proposalId
          ? this.#proposals.get(call.threadId)?.get(proposalId)
          : undefined;
        if (!proposal) {
          return failed("context_update=denied\nreason=proposal-not-found-or-not-current-turn");
        }
        const approval: AgentApprovalRequest = {
          requestId: `context-${safeToken(call.callId)}`,
          kind: "file-change",
          capability: "files.write",
          source: "floral",
          summary: [
            "FLORAL Agent 请求写入受治理的项目上下文。",
            `target=${proposal.target}`,
            `characters=${String(proposal.text.length)}`,
            `evidence_refs=${String(proposal.evidenceRefs.length)}`,
          ].join(" "),
        };
        call.onApprovalRequested?.(approval);
        const decision = await call.approvalHandler?.(approval)
          .catch(() => "deny" as const) ?? "deny";
        if (decision !== "approve" && decision !== "approve-session") {
          return failed("context_update=denied\nreason=user-approval");
        }
        const result = await recordProjectMemory(
          project,
          proposal.target,
          proposal.text,
          new Date(),
          { source: "agent-proposal", evidenceRefs: proposal.evidenceRefs },
        );
        this.#proposals.get(call.threadId)?.delete(proposal.id);
        return ok([
          `context_update=${result.changed ? "applied" : "duplicate"}`,
          `target=${proposal.target}`,
          `ledger_entry_id=${result.ledgerEntryId}`,
          "verification_tool=floral_context/verify",
        ].join("\n"));
      }

      if (call.tool === "verify") {
        const ledgerEntryId = readLedgerEntryId(call.arguments.ledger_entry_id);
        const verification = ledgerEntryId
          ? await verifyProjectMemoryLedgerEntry(project, ledgerEntryId)
          : undefined;
        if (!verification) {
          return failed("context_verification=unavailable\nreason=ledger-entry-not-found-or-unsupported-target");
        }
        return {
          success: verification.present,
          text: [
            `context_verification=${verification.present ? "present" : "missing"}`,
            `target=${verification.target}`,
            `ledger_entry_id=${verification.ledgerEntryId}`,
          ].join("\n"),
        };
      }

      if (call.tool === "history") {
        const entries = await listProjectContextLedgerEntries(project);
        return ok([
          `ledger_entries=${String(entries.length)}`,
          ...entries.slice(-20).map((entry) => [
            `id=${entry.id}`,
            `target=${entry.target}`,
            `status=${entry.status}`,
            `source=${entry.source}`,
            `verified=${entry.verifiedAt ? "true" : "false"}`,
          ].join(" ")),
        ].join("\n"));
      }

      if (call.tool === "compact") {
        return ok("context_compaction=deferred\nreason=durable-transaction-journal-required");
      }
    } catch (error) {
      return failed(
        `context_management=failed\nreason=${safeToken(error instanceof Error ? error.name : "Error")}`,
      );
    }
    return failed("context_management=denied\nreason=unsupported-tool");
  }
}

function ok(text: string): FloralContextToolResult {
  return { success: true, text };
}

function failed(text: string): FloralContextToolResult {
  return { success: false, text };
}

function readProjectContextTarget(value: unknown): ProjectMemoryKind | undefined {
  return value === "context" || value === "decision" || value === "issue"
    ? value
    : undefined;
}

function readProjectContextText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)) return undefined;
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized && Array.from(normalized).length <= 1_200 ? normalized : undefined;
}

function readProjectContextEvidenceRefs(value: unknown): string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16) return undefined;
  const output: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (
      typeof entry !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/u.test(entry)
    ) return undefined;
    if (!seen.has(entry)) {
      seen.add(entry);
      output.push(entry);
    }
  }
  return output.sort();
}

function readContextProposalId(value: unknown): string | undefined {
  return typeof value === "string" && /^ctx-[a-f0-9]{20}$/u.test(value)
    ? value
    : undefined;
}

function readLedgerEntryId(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-f0-9]{32}$/u.test(value)
    ? value
    : undefined;
}

function boundedToolText(value: string): string {
  const normalized = value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, " ")
    .trim();
  return normalized.length <= 12_000
    ? normalized
    : `${normalized.slice(0, 11_980)}\ntruncated=true`;
}

function safeToken(value: string): string {
  const normalized = value
    .replace(/[^A-Za-z0-9._:-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return normalized.slice(0, 96) || "unknown";
}
