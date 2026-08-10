import { randomBytes } from "node:crypto";
import type {
  AgentApprovalDecision,
  AgentApprovalRequest,
  AuditEventInput,
  GatewayRole,
} from "../core/types.js";
import type { InteractiveApprovalPrompt } from "../core/contracts.js";
import type { AuthorizationAuthority } from "./authorization-authority.js";
import type { LocalConfirmationBroker } from "./local-confirmation-broker.js";

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
  sendInteractive?: ((prompt: InteractiveApprovalPrompt) => Promise<void>) | undefined;
  audit: (event: AuditEventInput) => Promise<void>;
  now?: (() => number) | undefined;
  createPublicId?: (() => string) | undefined;
  localConfirmation?: LocalConfirmationBroker | undefined;
  autoApproveSystemMaintenance?: ((
    scope: ApprovalRequesterScope,
    request: AgentApprovalRequest,
  ) => Promise<{ approved: boolean; reason: string }>) | undefined;
  autoApproveChatConfirmation?: ((
    scope: ApprovalRequesterScope,
    request: AgentApprovalRequest,
  ) => Promise<{ approved: boolean; reason: string }>) | undefined;
}

export type ApprovalResolveResult =
  | "approved"
  | "approved-session"
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
      ...(request.scope ? { scope: request.scope } : {}),
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

    if (decision.approvalLevel === "chat-confirmation" && this.options.ownerOnly && scope.role !== "owner") {
      await this.#audit(scope, "authorization.remote_approval_owner_required", request);
      return "deny";
    }

    if (decision.approvalLevel === "chat-confirmation" && this.options.autoApproveChatConfirmation) {
      const trusted = await this.options.autoApproveChatConfirmation(scope, request)
        .catch(() => ({ approved: false, reason: "trusted-owner-policy-error" }));
      if (trusted.approved) {
        await this.#audit(scope, "authorization.trusted_owner_auto_approved", request, {
          autonomyReason: trusted.reason,
        });
        return "approve";
      }
      await this.#audit(scope, "authorization.trusted_owner_auto_not_applicable", request, {
        autonomyReason: trusted.reason,
      });
    }

    if (decision.approvalLevel === "local-confirmation") {
      if (request.kind === "system-maintenance" && this.options.autoApproveSystemMaintenance) {
        const autonomous = await this.options.autoApproveSystemMaintenance(scope, request)
          .catch(() => ({ approved: false, reason: "autonomy-policy-error" }));
        if (autonomous.approved) {
          await this.#audit(scope, "authorization.maintenance_auto_approved", request, {
            autonomyReason: autonomous.reason,
          });
          return "approve";
        }
        await this.#audit(scope, "authorization.maintenance_auto_not_applicable", request, {
          autonomyReason: autonomous.reason,
        });
      }
      await this.#audit(scope, "authorization.local_confirmation_required", request);
      const local = this.options.localConfirmation;
      const handle = local
        ? await local.request(
            {
              userId: scope.userId,
              role: scope.role,
              conversationId: scope.conversationId,
            },
            request,
          ).catch(() => undefined)
        : undefined;
      if (!handle) {
        await this.options.send(
          scope.deliveryConversationId,
          [
            "FLORAL 已拒绝远程审批请求。",
            `能力=${request.capability}`,
            "该操作要求 Mac 本地确认，但本地确认通道当前不可用。",
          ].join("\n"),
        ).catch(() => undefined);
        return "deny";
      }

      try {
        await this.options.send(
          scope.deliveryConversationId,
          localApprovalPrompt(handle.notice.publicId, request, handle.notice.ttlMs),
        );
      } catch {
        local?.cancelConversation(scope.conversationId);
        return "deny";
      }
      const localDecision = await handle.decision;
      await this.#audit(
        scope,
        localDecision === "approve"
          ? "authorization.local_confirmation_approved"
          : "authorization.local_confirmation_denied",
        request,
      );
      return localDecision;
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
      let presentation: "interactive" | "command-fallback" = "command-fallback";
      if (this.options.sendInteractive) {
        try {
          await this.options.sendInteractive({
            conversationId: scope.deliveryConversationId,
            approvalId: publicId,
            capability: request.capability,
            summary: boundedSummary(request.summary),
            ttlMs: this.options.ttlMs,
            allowSession: request.kind !== "mcp-tool"
              && request.kind !== "skill-management"
              && request.kind !== "extension-management"
              && request.kind !== "system-maintenance",
          });
          presentation = "interactive";
        } catch (error) {
          await this.#audit(
            scope,
            "authorization.approval_interactive_delivery_failed",
            request,
            { errorType: error instanceof Error ? error.name : "unknown" },
          );
        }
      }

      if (presentation === "command-fallback") {
        await this.options.send(
          scope.deliveryConversationId,
          approvalPrompt(publicId, request, this.options.ttlMs),
        );
      }
      await this.#audit(scope, "authorization.approval_requested", request, {
        approvalId: publicId,
        ttlMs: this.options.ttlMs,
        presentation,
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

    if (
      (pending.request.kind === "skill-management"
        || pending.request.kind === "extension-management"
        || pending.request.kind === "system-maintenance"
        || pending.request.kind === "mcp-tool")
      && decision === "approve-session"
    ) {
      await this.#audit(
        pending.scope,
        "authorization.approval_session_not_supported",
        pending.request,
      );
      return "not-authorized";
    }

    this.#finish(normalizedId, decision);
    await this.#audit(
      pending.scope,
      decision === "approve"
        ? "authorization.approval_granted"
        : decision === "approve-session"
          ? "authorization.approval_granted_session"
          : "authorization.approval_denied",
      pending.request,
      { approvalId: normalizedId },
    );
    if (decision === "approve") return "approved";
    if (decision === "approve-session") return "approved-session";
    return "denied";
  }

  pendingCount(conversationId?: string): number {
    const remote = !conversationId
      ? this.#pending.size
      : [...this.#pending.values()].filter((pending) =>
          pending.scope.conversationId === conversationId
        ).length;
    return remote + (this.options.localConfirmation?.pendingCount(conversationId) ?? 0);
  }

  cancelConversation(conversationId: string): void {
    this.options.localConfirmation?.cancelConversation(conversationId);
    for (const [publicId, pending] of this.#pending) {
      if (pending.scope.conversationId !== conversationId) continue;
      this.#finish(publicId, "deny");
      void this.#audit(pending.scope, "authorization.approval_cancelled", pending.request);
    }
  }

  cancelAll(): void {
    this.options.localConfirmation?.cancelAll();
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
        ...(request.scope ? { scope: request.scope } : {}),
        ...extra,
      },
    }).catch(() => undefined);
  }
}

function sourceFor(
  request: AgentApprovalRequest,
): "codex-command" | "codex-file-change" | "codex-permission-request" | "codex-permission-profile" | "mcp-tool" | "floral-skill" | "floral-extension" | "floral-maintenance" | "floral" {
  if (request.kind === "command-execution") return "codex-command";
  if (request.kind === "file-change") return "codex-file-change";
  if (request.kind === "permission-request") return "codex-permission-request";
  if (request.kind === "permission-profile") return "codex-permission-profile";
  if (request.kind === "mcp-tool") return "mcp-tool";
  if (request.kind === "skill-management") return "floral-skill";
  if (request.kind === "extension-management") return "floral-extension";
  if (request.kind === "system-maintenance") return "floral-maintenance";
  return "floral";
}

function localApprovalPrompt(
  publicId: string,
  request: AgentApprovalRequest,
  ttlMs: number,
): string {
  const seconds = Math.max(1, Math.ceil(ttlMs / 1_000));
  return [
    "FLORAL 要求 Mac 本地确认",
    `本地审批编号=${publicId}`,
    `能力=${request.capability}`,
    "请求详情仅在 Mac 本地显示，避免高风险命令内容进入远程聊天。",
    `有效期=${seconds} 秒`,
    `Mac 查看：corepack pnpm approval:local:list`,
    `Mac 允许：corepack pnpm approval:local:approve -- ${publicId}`,
    `Mac 拒绝：corepack pnpm approval:local:deny -- ${publicId}`,
    "远程 /approve 无法授权此操作。",
  ].join("\n");
}

function approvalPrompt(
  publicId: string,
  request: AgentApprovalRequest,
  ttlMs: number,
): string {
  const seconds = Math.max(1, Math.ceil(ttlMs / 1_000));
  const lines = [
    "FLORAL 请求一次性授权",
    `审批编号=${publicId}`,
    `能力=${request.capability}`,
    `请求=${boundedSummary(request.summary)}`,
    ...approvalScopeLines(request),
    `有效期=${seconds} 秒`,
    `允许一次：/approve ${publicId}`,
  ];
  if (
    request.kind !== "mcp-tool"
    && request.kind !== "skill-management"
    && request.kind !== "extension-management"
    && request.kind !== "system-maintenance"
  ) {
    lines.push(`本会话允许：/approve-session ${publicId}`);
  }
  lines.push(
    `拒绝：/deny ${publicId}`,
    "权限决定由 Codex 原生审批/会话缓存执行；FLORAL 不维护影子命令白名单。",
  );
  return lines.join("\n");
}

function approvalScopeLines(request: AgentApprovalRequest): string[] {
  const scope = request.scope;
  if (!scope) return [];
  if (scope.type === "skill-publish") {
    return [
      `项目 Skill=${scope.targetName}`,
      `动作=${scope.action}`,
      `草稿摘要=${scope.digest}`,
      `声明权限=${scope.permissions.join(",") || "none"}`,
    ];
  }
  if (scope.type === "mcp-tool") {
    return [
      `MCP=${scope.serverId}/${scope.toolName}`,
      `目标=${boundedSummary(scope.target)}`,
      `参数摘要=${scope.argumentsDigest}`,
    ];
  }
  return [
    `扩展=${scope.extensionKind}/${scope.targetId}`,
    `动作=${scope.action}`,
    `来源=${boundedSummary(scope.sourceId)}`,
    `版本=${boundedSummary(scope.sourceVersion)}`,
    ...(scope.integrity ? [`完整性=${scope.integrity}`] : []),
    `权限=${scope.permissions.join(",")}`,
  ];
}

function boundedSummary(value: string): string {
  const normalized = value.replace(/[\u0000-\u001F\u007F]+/gu, " ").replace(/\s+/gu, " ").trim();
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 237)}...`;
}
