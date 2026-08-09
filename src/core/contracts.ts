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
  materializeInboundAttachments(
    message: IncomingMessage,
    options?: { projectNamespace?: string | undefined },
  ): Promise<IncomingMessage>;
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

export interface AgentSkillControlRuntime extends AgentSkillRuntime {
  setSkillRoots(roots: string[]): Promise<void>;
}

export function supportsAgentSkillControl(
  runtime: AgentRuntime,
): runtime is AgentRuntime & AgentSkillControlRuntime {
  const candidate = runtime as Partial<AgentSkillControlRuntime>;
  return typeof candidate.listSkills === "function"
    && typeof candidate.setSkillRoots === "function";
}

export interface AgentAppSummary {
  id: string;
  runtimeName?: string | undefined;
  description?: string | undefined;
  installUrl?: string | undefined;
  enabled: boolean;
  callable?: boolean | undefined;
  accessible?: boolean | undefined;
  source: "installed-runtime" | "directory" | "directory-fallback";
}

export interface AgentAppToolSummary {
  name: string;
  title?: string | undefined;
  description?: string | undefined;
  enabled: boolean;
  readOnly: boolean;
  disabledReason?: string | undefined;
}

export interface AgentAppDetail {
  id: string;
  name: string;
  description?: string | undefined;
  pluginDisplayNames: string[];
  tools: AgentAppToolSummary[];
}

export interface AgentAppReadResult {
  apps: AgentAppDetail[];
  missingAppIds: string[];
}

export interface AgentNativeFeatureSummary {
  name: string;
  stage: "beta" | "underDevelopment" | "stable" | "deprecated" | "removed" | "unknown";
  enabled: boolean;
  defaultEnabled: boolean;
}

export interface AgentMcpToolSummary {
  name: string;
  readOnly?: boolean | undefined;
}

export interface AgentMcpServerSummary {
  name: string;
  status: "starting" | "ready" | "failed" | "cancelled" | "unknown";
  authStatus?: string | undefined;
  failureReason?: string | undefined;
  tools: AgentMcpToolSummary[];
}

export interface AgentExtensionDiscoveryRuntime {
  listInstalledApps(input: {
    cwd: string;
    threadId?: string | undefined;
    forceRefresh?: boolean | undefined;
  }): Promise<AgentAppSummary[]>;
  listAvailableApps(input: {
    cwd: string;
    threadId?: string | undefined;
    forceRefresh?: boolean | undefined;
  }): Promise<AgentAppSummary[]>;
  readApps(input: {
    cwd: string;
    appIds: string[];
    includeTools?: boolean | undefined;
  }): Promise<AgentAppReadResult>;
  listNativeExtensionFeatures(input: {
    cwd: string;
  }): Promise<AgentNativeFeatureSummary[]>;
  listMcpServers(input: {
    cwd: string;
    threadId?: string | undefined;
  }): Promise<AgentMcpServerSummary[]>;
}

export function supportsAgentExtensionDiscovery(
  runtime: AgentRuntime,
): runtime is AgentRuntime & AgentExtensionDiscoveryRuntime {
  const candidate = runtime as Partial<AgentExtensionDiscoveryRuntime>;
  return typeof candidate.listInstalledApps === "function"
    && typeof candidate.listAvailableApps === "function"
    && typeof candidate.readApps === "function"
    && typeof candidate.listNativeExtensionFeatures === "function"
    && typeof candidate.listMcpServers === "function";
}

export interface AgentExtensionControlRuntime extends AgentExtensionDiscoveryRuntime {
  reloadMcpServers(): Promise<void>;
}

export function supportsAgentExtensionControl(
  runtime: AgentRuntime,
): runtime is AgentRuntime & AgentExtensionControlRuntime {
  const candidate = runtime as Partial<AgentExtensionControlRuntime>;
  return supportsAgentExtensionDiscovery(runtime)
    && typeof candidate.reloadMcpServers === "function";
}

export interface AgentProjectRuntimeStorage {
  resolveRuntimeHome(input: { cwd: string }): Promise<string>;
}

export function supportsAgentProjectRuntimeStorage(
  runtime: AgentRuntime,
): runtime is AgentRuntime & AgentProjectRuntimeStorage {
  return typeof (runtime as Partial<AgentProjectRuntimeStorage>)
    .resolveRuntimeHome === "function";
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
