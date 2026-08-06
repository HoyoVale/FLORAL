export type BridgeCapacityFailureKind =
  | "queue_full"
  | "queue_timeout"
  | "queue_cancelled"
  | "gate_closed";

export interface BridgeCapacitySnapshot {
  active: number;
  queued: number;
  maxConcurrent: number;
  maxQueued: number;
  queueTimeoutMs: number;
  closed: boolean;
}

export class BridgeCapacityError extends Error {
  readonly kind: BridgeCapacityFailureKind;
  readonly retryAfterMs: number;

  constructor(kind: BridgeCapacityFailureKind, retryAfterMs: number) {
    super(messageFor(kind));
    this.name = "BridgeCapacityError";
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
}

interface QueueEntry {
  resolve: (release: () => void) => void;
  reject: (error: BridgeCapacityError) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal | undefined;
  onAbort?: (() => void) | undefined;
}

export class BridgeConcurrencyGate {
  readonly #maxConcurrent: number;
  readonly #maxQueued: number;
  readonly #queueTimeoutMs: number;
  readonly #queue: QueueEntry[] = [];
  #active = 0;
  #closed = false;

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
      closed: this.#closed,
    };
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.#closed) {
      return Promise.reject(new BridgeCapacityError("gate_closed", 0));
    }
    if (signal?.aborted) {
      return Promise.reject(new BridgeCapacityError("queue_cancelled", 0));
    }
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
        signal,
        timer: setTimeout(() => {
          if (!this.#remove(entry)) return;
          this.#cleanup(entry);
          reject(new BridgeCapacityError("queue_timeout", this.#queueTimeoutMs));
        }, this.#queueTimeoutMs),
      };
      if (signal) {
        entry.onAbort = () => {
          if (!this.#remove(entry)) return;
          this.#cleanup(entry);
          reject(new BridgeCapacityError("queue_cancelled", 0));
        };
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      this.#queue.push(entry);
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const entry of this.#queue.splice(0)) {
      this.#cleanup(entry);
      entry.reject(new BridgeCapacityError("gate_closed", 0));
    }
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
    if (this.#closed) return;
    while (this.#active < this.#maxConcurrent) {
      const entry = this.#queue.shift();
      if (!entry) return;
      this.#cleanup(entry);
      if (entry.signal?.aborted) {
        entry.reject(new BridgeCapacityError("queue_cancelled", 0));
        continue;
      }
      entry.resolve(this.#grant());
    }
  }

  #remove(entry: QueueEntry): boolean {
    const index = this.#queue.indexOf(entry);
    if (index < 0) return false;
    this.#queue.splice(index, 1);
    return true;
  }

  #cleanup(entry: QueueEntry): void {
    clearTimeout(entry.timer);
    if (entry.signal && entry.onAbort) {
      entry.signal.removeEventListener("abort", entry.onAbort);
    }
  }
}

function messageFor(kind: BridgeCapacityFailureKind): string {
  switch (kind) {
    case "queue_full":
      return "Responses bridge capacity queue is full";
    case "queue_timeout":
      return "Responses bridge capacity wait timed out";
    case "queue_cancelled":
      return "Responses bridge capacity wait was cancelled";
    case "gate_closed":
      return "Responses bridge capacity gate is closed";
  }
}
