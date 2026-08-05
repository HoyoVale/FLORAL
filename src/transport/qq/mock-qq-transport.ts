import { randomUUID } from "node:crypto";
import { createInterface, type Interface } from "node:readline/promises";
import type { ChatTransport } from "../../core/contracts.js";
import type { IncomingMessage, OutgoingMessage } from "../../core/types.js";

export class MockQqTransport implements ChatTransport {
  readonly name = "mock-qq";
  #readline?: Interface;
  #stopped = false;
  #loop?: Promise<void>;

  async start(onMessage: (message: IncomingMessage) => Promise<void>): Promise<void> {
    this.#stopped = false;
    this.#readline = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY)
    });

    process.stdout.write("Mock QQ 已启动。输入消息后按 Enter，Ctrl+C 退出。\n");
    this.#loop = this.#runInputLoop(onMessage);
  }

  async send(message: OutgoingMessage): Promise<void> {
    process.stdout.write(`agent> ${message.text}\n`);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#readline?.close();
    await this.#loop?.catch(() => undefined);
  }

  async #runInputLoop(onMessage: (message: IncomingMessage) => Promise<void>): Promise<void> {
    const readline = this.#readline;
    if (!readline) return;

    while (!this.#stopped) {
      let line: string;
      try {
        // question() serializes prompt -> input -> processing -> next prompt.
        // This avoids prompt redraw races with PowerShell and Chinese IMEs.
        line = await readline.question("qq> ");
      } catch (error) {
        if (this.#stopped || isReadlineClosed(error)) return;
        throw error;
      }

      const text = line.trim();
      if (!text) continue;

      try {
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
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`agent error> ${message}\n`);
      }
    }
  }
}

function isReadlineClosed(error: unknown): boolean {
  return error instanceof Error && (
    error.name === "AbortError"
    || error.message.includes("readline was closed")
    || error.message.includes("Interface is closed")
  );
}
