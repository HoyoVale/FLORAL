import type { AgentRuntime, ChatTransport, ThreadStore } from "../core/contracts.js";
import type { IncomingMessage } from "../core/types.js";

export interface GatewayOptions {
  cwd: string;
  model?: string;
}

export class GatewayService {
  constructor(
    private readonly transport: ChatTransport,
    private readonly agent: AgentRuntime,
    private readonly threads: ThreadStore,
    private readonly options: GatewayOptions
  ) {}

  async start(): Promise<void> {
    await this.agent.start();
    await this.transport.start((message) => this.#handle(message));
  }

  async stop(): Promise<void> {
    await Promise.allSettled([this.transport.stop(), this.agent.stop()]);
  }

  async #handle(message: IncomingMessage): Promise<void> {
    if (!message.text) return;
    const threadId = await this.threads.getActiveThread(message.identity.conversationId);
    const result = await this.agent.run({
      ...(threadId ? { threadId } : {}),
      text: message.text,
      cwd: this.options.cwd,
      ...(this.options.model ? { model: this.options.model } : {})
    });
    await this.threads.setActiveThread(message.identity.conversationId, result.threadId);
    await this.transport.send({
      conversationId: message.identity.conversationId,
      text: result.finalText
    });
  }
}
