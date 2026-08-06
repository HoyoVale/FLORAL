export type BridgeCapacityFailureKind = "queue_full" | "queue_timeout";

export interface BridgeCapacitySnapshot {
  active: number;
  queued: number;
  maxConcurrent: number;
  maxQueued: number;
  queueTimeoutMs: number;
}

export class BridgeCapacityError extends Error {
  readonly kind: BridgeCapacityFailureKind;
  readonly retryAfterMs: number;

  constructor(kind: BridgeCapacityFailureKind, retryAfterMs: number) {
    super(
      kind === "queue_full"
        ? "Responses bridge capacity queue is full"
        : "Responses bridge capacity wait timed out",
    );
    this.name = "BridgeCapacityError";
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
}

interface QueueEntry {
  resolve: (release: () => void) => void;
  reject: (error: BridgeCapacityError) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class BridgeConcurrencyGate {
  readonly #maxConcurrent: number;
  readonly #maxQueued: number;
  readonly #queueTimeoutMs: number;
  readonly #queue: QueueEntry[] = [];
  #active = 0;

  constructor(maxConcurrent: number, maxQueued: number, queueTimeoutMs: number) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent <= 0) {
      throw new Error("Bridge max concurrent requests must be a positive integer");
    }
    if (!Number.isInteger(maxQueued) || maxQueued < 0) {
      throw new Error("Bridge max queued requests must be a non-negative integer");
    }
    if (!Number.isInteger(queueTimeoutMs) || queueTimeoutMs <= 0) {
      throw new Error("Bridge queue timeout must be a positive integer");
    }
    this.#maxConcurrent = maxConcurrent;
    this.#maxQueued = maxQueued;
    this.#queueTimeoutMs = queueTimeoutMs;
  }

  snapshot(): BridgeCapacitySnapshot {
    return {
      active: this.#active,
      queued: this.#queue.length,
      maxConcurrent: this.#maxConcurrent,
      maxQueued: this.#maxQueued,
      queueTimeoutMs: this.#queueTimeoutMs,
    };
  }

  acquire(): Promise<() => void> {
    if (this.#active < this.#maxConcurrent) {
      return Promise.resolve(this.#grant());
    }
    if (this.#queue.length >= this.#maxQueued) {
      return Promise.reject(new BridgeCapacityError("queue_full", this.#queueTimeoutMs));
    }

    return new Promise<() => void>((resolve, reject) => {
      const entry: QueueEntry = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.#queue.indexOf(entry);
          if (index >= 0) this.#queue.splice(index, 1);
          reject(new BridgeCapacityError("queue_timeout", this.#queueTimeoutMs));
        }, this.#queueTimeoutMs),
      };
      this.#queue.push(entry);
    });
  }

  #grant(): () => void {
    this.#active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active -= 1;
      this.#drain();
    };
  }

  #drain(): void {
    while (this.#active < this.#maxConcurrent) {
      const entry = this.#queue.shift();
      if (!entry) return;
      clearTimeout(entry.timer);
      entry.resolve(this.#grant());
    }
  }
}
