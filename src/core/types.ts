export type TransportKind = "qq" | "feishu" | "mock";
export type GatewayRole = "owner" | "operator" | "viewer";

export type Capability =
  | "machine.status.read"
  | "screen.capture"
  | "files.read"
  | "files.write"
  | "files.delete"
  | "shell.execute"
  | "software.install"
  | "extension.install"
  | "extension.update"
  | "extension.remove"
  | "extension.enable"
  | "extension.disable"
  | "skill.publish"
  | "github.repository.read"
  | "github.issue.write"
  | "github.pull-request.write"
  | "github.actions.run"
  | "browser.inspect"
  | "application.open"
  | "application.control"
  | "browser.submit"
  | "message.send"
  | "web.search"
  | "codex.permission.grant"
  | "system.restart"
  | "system.admin";

export type AgentApprovalKind =
  | "command-execution"
  | "file-change"
  | "permission-request"
  | "permission-profile"
  | "mcp-tool"
  | "skill-management"
  | "extension-management"
  | "system-maintenance";

export type AgentApprovalDecision = "approve" | "approve-session" | "deny";
export type AgentLocalApprovalDecision = Exclude<AgentApprovalDecision, "approve-session">;

export type ExtensionApprovalAction =
  | "install"
  | "update"
  | "remove"
  | "enable"
  | "disable";

export interface AgentExtensionApprovalScope {
  type: "extension";
  extensionKind: "mcp" | "skill" | "plugin" | "app";
  targetId: string;
  action: ExtensionApprovalAction;
  sourceId: string;
  sourceVersion: string;
  integrity?: string | undefined;
  permissions: Capability[];
}

export interface AgentSkillPublishApprovalScope {
  type: "skill-publish";
  projectId: string;
  targetName: string;
  action: "create" | "update";
  digest: string;
  permissions: Capability[];
}

export type AgentApprovalScope =
  | AgentExtensionApprovalScope
  | AgentSkillPublishApprovalScope;

export interface AgentApprovalRequest {
  requestId: string;
  kind: AgentApprovalKind;
  capability: Capability;
  summary: string;
  source: "codex" | "mcp" | "floral";
  mcpServerId?: string | undefined;
  mcpToolName?: string | undefined;
  scope?: AgentApprovalScope | undefined;
}

export type AgentApprovalHandler = (
  request: AgentApprovalRequest,
) => Promise<AgentApprovalDecision>;

export interface AgentSystemMaintenanceRequest {
  componentId: string;
  actionId: string;
  rationale: string;
}

export type AgentSystemMaintenanceResult =
  | {
      status: "queued";
      transactionId: string;
      message: string;
    }
  | {
      status: "denied" | "failed";
      transactionId?: string | undefined;
      reason: string;
    };

export type AgentSystemMaintenanceHandler = (
  request: AgentSystemMaintenanceRequest,
) => Promise<AgentSystemMaintenanceResult>;

export interface ExternalIdentity {
  transport: TransportKind;
  botId: string;
  externalUserId: string;
  conversationId: string;
  displayName?: string;
}

export type IncomingAttachmentKind = "image" | "file";

export interface IncomingAttachment {
  id: string;
  kind: IncomingAttachmentKind;
  fileName?: string | undefined;
  localPath?: string | undefined;
  byteLength?: number | undefined;
  source: {
    transport: "feishu";
    messageId: string;
    resourceKey: string;
  };
}

export interface IncomingMessage {
  id: string;
  identity: ExternalIdentity;
  text: string;
  attachments?: IncomingAttachment[] | undefined;
  receivedAt: Date;
}

export interface OutgoingMessage {
  conversationId: string;
  text: string;
}

export type OutgoingMediaKind = "image" | "file";

export interface OutgoingMediaMessage {
  conversationId: string;
  kind: OutgoingMediaKind;
  localPath: string;
  fileName?: string | undefined;
  caption?: string | undefined;
}

export type AgentArtifactSource =
  | {
      type: "mcp";
      serverId: string;
      toolName: string;
    }
  | {
      type: "floral";
      capability: Capability;
    };

export interface AgentArtifact {
  id: string;
  kind: OutgoingMediaKind;
  localPath: string;
  source: AgentArtifactSource;
  fileName?: string | undefined;
  caption?: string | undefined;
}

export interface AgentArtifactRegistrationRequest {
  localPath: string;
  fileName?: string | undefined;
  caption?: string | undefined;
}

export type AgentArtifactRegistrationResult =
  | { status: "registered"; artifactId: string }
  | { status: "denied"; reason: string };

export type AgentArtifactRegistrationHandler = (
  request: AgentArtifactRegistrationRequest,
) => Promise<AgentArtifactRegistrationResult>;

export interface AgentArtifactDeliveryRequest {
  artifactId: string;
  caption?: string | undefined;
}

export type AgentArtifactDeliveryResult =
  | {
      status: "sent";
      artifactId: string;
      kind: OutgoingMediaKind;
      byteLength: number;
    }
  | {
      status: "denied" | "failed";
      artifactId: string;
      reason: string;
    };

export type AgentArtifactDeliveryHandler = (
  request: AgentArtifactDeliveryRequest,
) => Promise<AgentArtifactDeliveryResult>;

export type AgentEvent =
  | { type: "run.started"; threadId: string }
  | { type: "assistant.delta"; text: string }
  | { type: "tool.started"; name: string; detail?: unknown }
  | { type: "tool.completed"; name: string; detail?: unknown }
  | { type: "artifact.registered"; artifact: AgentArtifact }
  // Legacy event: existing producers may still request immediate egress.
  | { type: "artifact.available"; artifact: AgentArtifact }
  | {
      type: "approval.requested";
      requestId: string;
      capability: Capability;
      kind: AgentApprovalKind;
      detail?: unknown;
    }
  | { type: "run.completed"; threadId: string; finalText: string }
  | { type: "run.failed"; threadId?: string; message: string };

export interface AgentRunRequest {
  threadId?: string;
  text: string;
  cwd: string;
  model?: string;
  approvalPolicy?: "never" | "on-request" | "untrusted";
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  approvalsReviewer?: "user" | "auto_review";
  controlMode?: "ask" | "auto" | "full";
  approvalRoute?: "owner" | "auto-review" | "full-auto-owner-trusted";
  approvalHandler?: AgentApprovalHandler;
  mcpToolApprovalHandler?: AgentApprovalHandler;
  skillManagementApprovalHandler?: AgentApprovalHandler;
  extensionManagementApprovalHandler?: AgentApprovalHandler;
  systemMaintenanceApprovalHandler?: AgentApprovalHandler;
  systemMaintenanceHandler?: AgentSystemMaintenanceHandler;
  artifactRegistrationHandler?: AgentArtifactRegistrationHandler;
  artifactDeliveryHandler?: AgentArtifactDeliveryHandler;
}

export interface AgentRunResult {
  threadId: string;
  finalText: string;
}

export interface ResolvedGatewayIdentity {
  userId: string;
  role: GatewayRole;
  conversationId: string;
}

export interface AuditEventInput {
  userId?: string;
  conversationId?: string;
  eventType: string;
  payload?: Record<string, unknown>;
  createdAt?: Date;
}
