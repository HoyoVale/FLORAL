import type { ThreadStore } from "../core/contracts.js";

export class MemoryThreadStore implements ThreadStore {
  readonly #threads = new Map<string, string>();

  async getActiveThread(conversationId: string): Promise<string | undefined> {
    return this.#threads.get(conversationId);
  }

  async setActiveThread(conversationId: string, threadId: string): Promise<void> {
    this.#threads.set(conversationId, threadId);
  }
}
