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

export type FeishuWorkerMessage =
  | { type: "started" }
  | { type: "message"; message: SerializedFeishuIncomingMessage }
  | { type: "fatal"; errorType: string };
