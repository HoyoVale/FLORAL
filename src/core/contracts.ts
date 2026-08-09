import type {
  AgentEvent,
  AgentRunRequest,
  AgentRunResult,
  AuditEventInput,
  ExternalIdentity,
  IncomingMessage,
  OutgoingMediaMessage,
  OutgoingMessage,
  ResolvedGatewayIdentity,
  TransportKind,
} from "./types.js";

export interface ChatTransport {
  readonly name: string;
  start(onMessage: (message: IncomingMessage) => Promise<void>): Promise<void>;
  send(message: OutgoingMessage): Promise<void>;
  stop(): Promise<void>;
}

export type ConversationActivityState = "typing" | "idle";

export interface ConversationActivityTransport {
  setConversationActivity(
    conversationId: string,
    state: ConversationActivityState,
  ): Promise<void>;
}

export function supportsConversationActivity(
  transport: ChatTransport,
): transport is ChatTransport & ConversationActivityTransport {
  return typeof (transport as Partial<ConversationActivityTransport>)
    .setConversationActivity === "function";
}

export interface InteractiveApprovalPrompt {
  conversationId: string;
  approvalId: string;
  capability: string;
  summary: string;
  ttlMs: number;
  allowSession?: boolean | undefined;
}

export interface InteractiveApprovalTransport {
  sendInteractiveApprovalPrompt(prompt: InteractiveApprovalPrompt): Promise<void>;
}

export function supportsInteractiveApproval(
  transport: ChatTransport,
): transport is ChatTransport & InteractiveApprovalTransport {
  return typeof (transport as Partial<InteractiveApprovalTransport>)
    .sendInteractiveApprovalPrompt === "function";
}

export interface InboundAttachmentMaterializer {
  materializeInboundAttachments(message: IncomingMessage): Promise<IncomingMessage>;
}

export function supportsInboundAttachmentMaterializer(
  transport: ChatTransport,
): transport is ChatTransport & InboundAttachmentMaterializer {
  return typeof (transport as Partial<InboundAttachmentMaterializer>)
    .materializeInboundAttachments === "function";
}

export interface MediaTransport {
  sendMedia(message: OutgoingMediaMessage): Promise<void>;
}

export function supportsMediaTransport(
  transport: ChatTransport,
): transport is ChatTransport & MediaTransport {
  return typeof (transport as Partial<MediaTransport>).sendMedia === "function";
}

export interface AgentRuntime {
  readonly name: string;
  start(): Promise<void>;
  run(request: AgentRunRequest, onEvent?: (event: AgentEvent) => void): Promise<AgentRunResult>;
  interrupt(threadId: string, turnId?: string): Promise<void>;
  stop(): Promise<void>;
}

export interface AgentThreadSummary {
  id: string;
  preview: string;
  createdAt?: number | undefined;
  updatedAt?: number | undefined;
}

export type AgentSkillScope = "user" | "repo" | "system" | "admin";

export interface AgentSkillSummary {
  name: string;
  description: string;
  path: string;
  scope: AgentSkillScope;
  enabled: boolean;
}

export interface AgentSkillRuntime {
  listSkills(input: {
    cwd: string;
    forceReload?: boolean | undefined;
  }): Promise<AgentSkillSummary[]>;
}

export function supportsAgentSkills(
  runtime: AgentRuntime,
): runtime is AgentRuntime & AgentSkillRuntime {
  return typeof (runtime as Partial<AgentSkillRuntime>).listSkills === "function";
}

export interface AgentThreadManagementRuntime {
  listThreads(input: {
    cwd: string;
    limit?: number | undefined;
  }): Promise<AgentThreadSummary[]>;
  archiveThread(threadId: string): Promise<void>;
}

export function supportsAgentThreadManagement(
  runtime: AgentRuntime,
): runtime is AgentRuntime & AgentThreadManagementRuntime {
  const candidate = runtime as Partial<AgentThreadManagementRuntime>;
  return typeof candidate.listThreads === "function"
    && typeof candidate.archiveThread === "function";
}

export interface WorkspaceStateStore {
  getSelectedProject(conversationId: string): Promise<string | undefined>;
  setSelectedProject(conversationId: string, projectName: string): Promise<void>;
  getProjectActiveThread(
    conversationId: string,
    projectName: string,
  ): Promise<string | undefined>;
  setProjectActiveThread(
    conversationId: string,
    projectName: string,
    threadId: string,
  ): Promise<void>;
  clearProjectActiveThread(
    conversationId: string,
    projectName: string,
  ): Promise<void>;
}

export function supportsWorkspaceStateStore(
  store: GatewayStore,
): store is GatewayStore & WorkspaceStateStore {
  const candidate = store as Partial<WorkspaceStateStore>;
  return typeof candidate.getSelectedProject === "function"
    && typeof candidate.setSelectedProject === "function"
    && typeof candidate.getProjectActiveThread === "function"
    && typeof candidate.setProjectActiveThread === "function"
    && typeof candidate.clearProjectActiveThread === "function";
}

export interface GatewayStore {
  resolveIdentity(identity: ExternalIdentity): Promise<ResolvedGatewayIdentity | undefined>;
  claimOwner(identity: ExternalIdentity): Promise<ResolvedGatewayIdentity>;
  hasOwner(transport: TransportKind, botId: string): Promise<boolean>;
  acceptMessage(
    identity: ExternalIdentity,
    messageId: string,
    receivedAt: Date,
  ): Promise<boolean>;
  getActiveThread(conversationId: string): Promise<string | undefined>;
  setActiveThread(conversationId: string, threadId: string): Promise<void>;
  clearActiveThread(conversationId: string): Promise<void>;
  appendAudit(event: AuditEventInput): Promise<void>;
  close(): Promise<void>;
}
