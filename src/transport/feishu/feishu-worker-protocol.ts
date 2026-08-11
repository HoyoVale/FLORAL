export interface FeishuWorkerConfig {
  appId: string;
  appSecret: string;
}

export interface SerializedFeishuIncomingAttachment {
  id: string;
  kind: "image" | "file";
  resourceKey: string;
  fileName?: string | undefined;
}

export interface SerializedFeishuIncomingMessage {
  id: string;
  botId: string;
  externalUserId: string;
  conversationId: string;
  text: string;
  attachments?: SerializedFeishuIncomingAttachment[] | undefined;
  receivedAtMs: number;
}

export interface SerializedFeishuApprovalAction {
  eventId: string;
  externalUserId: string;
  conversationId: string;
  approvalId: string;
  decision: "approve" | "deny";
  receivedAtMs: number;
}

export interface SerializedFeishuStatusControlAction {
  eventId: string;
  externalUserId: string;
  conversationId: string;
  action: "pause" | "stop" | "continue" | "restart";
  receivedAtMs: number;
}

export type FeishuWorkerMessage =
  | { type: "started" }
  | { type: "message"; message: SerializedFeishuIncomingMessage }
  | { type: "card-action"; action: SerializedFeishuApprovalAction }
  | { type: "status-control"; action: SerializedFeishuStatusControlAction }
  | { type: "fatal"; errorType: string };
