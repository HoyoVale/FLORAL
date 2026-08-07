export interface FeishuWorkerConfig {
  appId: string;
  appSecret: string;
}

export interface SerializedFeishuIncomingMessage {
  id: string;
  botId: string;
  externalUserId: string;
  conversationId: string;
  text: string;
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

export type FeishuWorkerMessage =
  | { type: "started" }
  | { type: "message"; message: SerializedFeishuIncomingMessage }
  | { type: "card-action"; action: SerializedFeishuApprovalAction }
  | { type: "fatal"; errorType: string };
