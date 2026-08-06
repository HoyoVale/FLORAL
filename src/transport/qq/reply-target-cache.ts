export interface CachedReplyTarget<T> {
  target: T;
  messageId: string;
  expiresAt: number;
}

export class ReplyTargetCache<T> {
  readonly #entries = new Map<string, CachedReplyTarget<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
      throw new Error("QQ reply target TTL must be a positive integer");
    }
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new Error("QQ reply target cache size must be a positive integer");
    }
  }

  set(conversationId: string, target: T, messageId: string): void {
    this.prune();
    this.#entries.delete(conversationId);
    this.#entries.set(conversationId, {
      target,
      messageId,
      expiresAt: this.now() + this.ttlMs,
    });

    while (this.#entries.size > this.maxEntries) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#entries.delete(oldest);
    }
  }

  get(conversationId: string): CachedReplyTarget<T> | undefined {
    const entry = this.#entries.get(conversationId);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.#entries.delete(conversationId);
      return undefined;
    }
    return entry;
  }

  delete(conversationId: string): void {
    this.#entries.delete(conversationId);
  }

  clear(): void {
    this.#entries.clear();
  }

  size(): number {
    this.prune();
    return this.#entries.size;
  }

  private prune(): void {
    const now = this.now();
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(key);
    }
  }
}
