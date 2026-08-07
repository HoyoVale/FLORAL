import type {
  AgentEvent,
  AgentRunRequest,
  AgentRunResult,
  AuditEventInput,
  ExternalIdentity,
  IncomingMessage,
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

export interface AgentRuntime {
  readonly name: string;
  start(): Promise<void>;
  run(request: AgentRunRequest, onEvent?: (event: AgentEvent) => void): Promise<AgentRunResult>;
  interrupt(threadId: string, turnId?: string): Promise<void>;
  stop(): Promise<void>;
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
