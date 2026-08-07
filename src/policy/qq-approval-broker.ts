import { randomBytes } from "node:crypto";
import type {
  AgentApprovalDecision,
  AgentApprovalRequest,
  AuditEventInput,
  GatewayRole,
} from "../core/types.js";
import type { AuthorizationAuthority } from "./authorization-authority.js";

export interface ApprovalRequesterScope {
  userId: string;
  role: GatewayRole;
  conversationId: string;
  deliveryConversationId: string;
}

export interface QqApprovalBrokerOptions {
  ttlMs: number;
  maxPending: number;
  ownerOnly: boolean;
  authority: AuthorizationAuthority;
  send: (conversationId: string, text: string) => Promise<void>;
  audit: (event: AuditEventInput) => Promise<void>;
  now?: (() => number) | undefined;
  createPublicId?: (() => string) | undefined;
}

export type ApprovalResolveResult =
  | "approved"
  | "denied"
  | "not-found"
  | "not-authorized";

interface PendingApproval {
  publicId: string;
  request: AgentApprovalRequest;
  scope: ApprovalRequesterScope;
  expiresAt: number;
  timer: NodeJS.Timeout;
  resolve: (decision: AgentApprovalDecision) => void;
}

export class QqApprovalBroker {
  readonly #pending = new Map<string, PendingApproval>();
  readonly #now: () => number;
  readonly #createPublicId: () => string;

  constructor(private readonly options: QqApprovalBrokerOptions) {
    if (!Number.isInteger(options.ttlMs) || options.ttlMs <= 0) {
      throw new Error("Approval TTL must be a positive integer");
    }
    if (!Number.isInteger(options.maxPending) || options.maxPending <= 0) {
      throw new Error("Approval maxPending must be a positive integer");
    }
    this.#now = options.now ?? Date.now;
    this.#createPublicId = options.createPublicId ?? (() =>
      randomBytes(8).toString("hex").toUpperCase()
    );
  }

  async request(
    scope: ApprovalRequesterScope,
    request: AgentApprovalRequest,
  ): Promise<AgentApprovalDecision> {
    const decision = this.options.authority.evaluate({
      role: scope.role,
      capability: request.capability,
      source: sourceFor(request),
      ...(request.mcpServerId ? { mcpServerId: request.mcpServerId } : {}),
      ...(request.mcpToolName ? { mcpToolName: request.mcpToolName } : {}),
    });

    if (decision.status === "allow") {
      await this.#audit(scope, "authorization.auto_approved", request, {
        approvalLevel: decision.approvalLevel,
      });
      return "approve";
    }

    if (decision.status === "deny") {
      await this.#audit(scope, "authorization.denied", request, {
        reason: decision.reason,
      });
      return "deny";
    }

    if (decision.approvalLevel === "local-confirmation") {
      await this.#audit(scope, "authorization.local_confirmation_required", request);
      await this.options.send(
        scope.deliveryConversationId,
        [
          "FLORAL 已拒绝远程审批请求。",
          `能力=${request.capability}`,
          "该操作要求 Mac 本地确认，QQ /approve 不能授权。",
        ].join("\n"),
      ).catch(() => undefined);
      return "deny";
    }

    if (this.options.ownerOnly && scope.role !== "owner") {
      await this.#audit(scope, "authorization.remote_approval_owner_required", request);
      return "deny";
    }
    if (this.#pending.size >= this.options.maxPending) {
      await this.#audit(scope, "authorization.approval_capacity_exceeded", request);
      return "deny";
    }

    const publicId = this.#uniquePublicId();
    const expiresAt = this.#now() + this.options.ttlMs;
    const result = new Promise<AgentApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        const pending = this.#pending.get(publicId);
        if (!pending) return;
        this.#pending.delete(publicId);
        void this.#audit(scope, "authorization.approval_expired", request);
        resolve("deny");
      }, this.options.ttlMs);
      timer.unref?.();
      this.#pending.set(publicId, {
        publicId,
        request,
        scope,
        expiresAt,
        timer,
        resolve,
      });
    });

    try {
      await this.options.send(
        scope.deliveryConversationId,
        approvalPrompt(publicId, request, this.options.ttlMs),
      );
      await this.#audit(scope, "authorization.approval_requested", request, {
        approvalId: publicId,
        ttlMs: this.options.ttlMs,
      });
    } catch {
      this.#finish(publicId, "deny");
      await this.#audit(scope, "authorization.approval_delivery_failed", request);
    }

    return await result;
  }

  async resolve(
    scope: Pick<ApprovalRequesterScope, "userId" | "role" | "conversationId">,
    publicId: string,
    decision: AgentApprovalDecision,
  ): Promise<ApprovalResolveResult> {
    const normalizedId = publicId.trim().toUpperCase();
    const pending = this.#pending.get(normalizedId);
    if (!pending) return "not-found";

    if (
      (this.options.ownerOnly && scope.role !== "owner")
      || pending.scope.userId !== scope.userId
      || pending.scope.conversationId !== scope.conversationId
    ) {
      await this.#audit(pending.scope, "authorization.approval_scope_mismatch", pending.request);
      return "not-authorized";
    }

    if (pending.expiresAt <= this.#now()) {
      this.#finish(normalizedId, "deny");
      await this.#audit(pending.scope, "authorization.approval_expired", pending.request);
      return "not-found";
    }

    this.#finish(normalizedId, decision);
    await this.#audit(
      pending.scope,
      decision === "approve"
        ? "authorization.approval_granted"
        : "authorization.approval_denied",
      pending.request,
      { approvalId: normalizedId },
    );
    return decision === "approve" ? "approved" : "denied";
  }

  pendingCount(conversationId?: string): number {
    if (!conversationId) return this.#pending.size;
    return [...this.#pending.values()].filter((pending) =>
      pending.scope.conversationId === conversationId
    ).length;
  }

  cancelConversation(conversationId: string): void {
    for (const [publicId, pending] of this.#pending) {
      if (pending.scope.conversationId !== conversationId) continue;
      this.#finish(publicId, "deny");
      void this.#audit(pending.scope, "authorization.approval_cancelled", pending.request);
    }
  }

  cancelAll(): void {
    for (const [publicId, pending] of [...this.#pending.entries()]) {
      this.#finish(publicId, "deny");
      void this.#audit(pending.scope, "authorization.approval_cancelled", pending.request);
    }
  }

  #finish(publicId: string, decision: AgentApprovalDecision): void {
    const pending = this.#pending.get(publicId);
    if (!pending) return;
    this.#pending.delete(publicId);
    clearTimeout(pending.timer);
    pending.resolve(decision);
  }

  #uniquePublicId(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = this.#createPublicId().trim().toUpperCase();
      if (!/^[A-Z0-9]{6,24}$/u.test(candidate)) {
        throw new Error("Approval public ID generator returned an invalid value");
      }
      if (!this.#pending.has(candidate)) return candidate;
    }
    throw new Error("Unable to allocate a unique approval ID");
  }

  async #audit(
    scope: Pick<ApprovalRequesterScope, "userId" | "conversationId">,
    eventType: string,
    request: AgentApprovalRequest,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await this.options.audit({
      userId: scope.userId,
      conversationId: scope.conversationId,
      eventType,
      payload: {
        capability: request.capability,
        kind: request.kind,
        source: request.source,
        ...extra,
      },
    }).catch(() => undefined);
  }
}

function sourceFor(
  request: AgentApprovalRequest,
): "codex-command" | "codex-file-change" | "codex-permission-profile" | "mcp-tool" | "floral" {
  if (request.kind === "command-execution") return "codex-command";
  if (request.kind === "file-change") return "codex-file-change";
  if (request.kind === "permission-profile") return "codex-permission-profile";
  if (request.kind === "mcp-tool") return "mcp-tool";
  return "floral";
}

function approvalPrompt(
  publicId: string,
  request: AgentApprovalRequest,
  ttlMs: number,
): string {
  const seconds = Math.max(1, Math.ceil(ttlMs / 1_000));
  return [
    "FLORAL 请求一次性授权",
    `审批编号=${publicId}`,
    `能力=${request.capability}`,
    `请求=${boundedSummary(request.summary)}`,
    `有效期=${seconds} 秒`,
    `允许：/approve ${publicId}`,
    `拒绝：/deny ${publicId}`,
    "授权仅对当前所有者、当前会话、当前请求生效。",
  ].join("\n");
}

function boundedSummary(value: string): string {
  const normalized = value.replace(/[\u0000-\u001F\u007F]+/gu, " ").replace(/\s+/gu, " ").trim();
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 237)}...`;
}
