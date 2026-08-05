import { randomUUID } from "node:crypto";
import type { AgentRuntime } from "../core/contracts.js";
import type { AgentEvent, AgentRunRequest, AgentRunResult } from "../core/types.js";

export class MockAgentRuntime implements AgentRuntime {
  readonly name = "mock-agent";

  async start(): Promise<void> {}

  async run(request: AgentRunRequest, onEvent?: (event: AgentEvent) => void): Promise<AgentRunResult> {
    const threadId = request.threadId ?? `mock_${randomUUID()}`;
    onEvent?.({ type: "run.started", threadId });
    const finalText = `[mock:${threadId.slice(0, 13)}] 已收到：${request.text}`;
    onEvent?.({ type: "assistant.delta", text: finalText });
    onEvent?.({ type: "run.completed", threadId, finalText });
    return { threadId, finalText };
  }

  async interrupt(): Promise<void> {}
  async stop(): Promise<void> {}
}
