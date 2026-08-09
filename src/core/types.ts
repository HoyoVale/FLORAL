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
  | "extension-management";

export type AgentApprovalDecision = "approve" | "approve-session" | "deny";
export type AgentLocalApprovalDecision = Exclude<AgentApprovalDecision, "approve-session">;

export interface AgentApprovalRequest {
  requestId: string;
  kind: AgentApprovalKind;
  capability: Capability;
  summary: string;
  source: "codex" | "mcp" | "floral";
  mcpServerId?: string | undefined;
  mcpToolName?: string | undefined;
}

export type AgentApprovalHandler = (
  request: AgentApprovalRequest,
) => Promise<AgentApprovalDecision>;

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
  approvalRoute?: "owner" | "auto-review" | "full-auto-codex-native";
  approvalHandler?: AgentApprovalHandler;
  mcpToolApprovalHandler?: AgentApprovalHandler;
  skillManagementApprovalHandler?: AgentApprovalHandler;
  extensionManagementApprovalHandler?: AgentApprovalHandler;
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
