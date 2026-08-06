export type TransportKind = "qq" | "mock";
export type GatewayRole = "owner" | "operator" | "viewer";

export interface ExternalIdentity {
  transport: TransportKind;
  botId: string;
  externalUserId: string;
  conversationId: string;
  displayName?: string;
}

export interface IncomingMessage {
  id: string;
  identity: ExternalIdentity;
  text: string;
  receivedAt: Date;
}

export interface OutgoingMessage {
  conversationId: string;
  text: string;
}

export type AgentEvent =
  | { type: "run.started"; threadId: string }
  | { type: "assistant.delta"; text: string }
  | { type: "tool.started"; name: string; detail?: unknown }
  | { type: "tool.completed"; name: string; detail?: unknown }
  | { type: "approval.requested"; requestId: string; detail: unknown }
  | { type: "run.completed"; threadId: string; finalText: string }
  | { type: "run.failed"; threadId?: string; message: string };

export interface AgentRunRequest {
  threadId?: string;
  text: string;
  cwd: string;
  model?: string;
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
