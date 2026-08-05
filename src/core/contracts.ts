import type { AgentEvent, AgentRunRequest, AgentRunResult, IncomingMessage, OutgoingMessage } from "./types.js";

export interface ChatTransport {
  readonly name: string;
  start(onMessage: (message: IncomingMessage) => Promise<void>): Promise<void>;
  send(message: OutgoingMessage): Promise<void>;
  stop(): Promise<void>;
}

export interface AgentRuntime {
  readonly name: string;
  start(): Promise<void>;
  run(request: AgentRunRequest, onEvent?: (event: AgentEvent) => void): Promise<AgentRunResult>;
  interrupt(threadId: string, turnId?: string): Promise<void>;
  stop(): Promise<void>;
}

export interface ThreadStore {
  getActiveThread(conversationId: string): Promise<string | undefined>;
  setActiveThread(conversationId: string, threadId: string): Promise<void>;
}
