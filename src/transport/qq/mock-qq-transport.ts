import { randomUUID } from "node:crypto";
import { createInterface, type Interface } from "node:readline";
import type { ChatTransport } from "../../core/contracts.js";
import type { IncomingMessage, OutgoingMessage } from "../../core/types.js";

export class MockQqTransport implements ChatTransport {
  readonly name = "mock-qq";
  #readline?: Interface;

  async start(onMessage: (message: IncomingMessage) => Promise<void>): Promise<void> {
    this.#readline = createInterface({ input: process.stdin, output: process.stdout, prompt: "qq> " });
    this.#readline.on("line", async (line) => {
      const text = line.trim();
      if (!text) return this.#readline?.prompt();
      await onMessage({
        id: randomUUID(),
        identity: {
          transport: "mock",
          botId: "local",
          externalUserId: "owner",
          conversationId: "mock-owner"
        },
        text,
        receivedAt: new Date()
      });
      this.#readline?.prompt();
    });
    this.#readline.prompt();
  }

  async send(message: OutgoingMessage): Promise<void> {
    process.stdout.write(`\nagent> ${message.text}\n`);
  }

  async stop(): Promise<void> {
    this.#readline?.close();
  }
}
