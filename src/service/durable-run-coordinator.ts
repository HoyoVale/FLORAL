import { randomUUID } from "node:crypto";
import type { IncomingMessage, ResolvedGatewayIdentity } from "../core/types.js";
import type {
  DurableAgentRunRecord,
  DurableRunQueueStore,
} from "../storage/durable-run-queue.js";

export interface DurableRunCoordinatorOptions {
  instanceId?: string | undefined;
  leaseTtlMs?: number | undefined;
}

export class DurableRunCoordinator {
  readonly #instanceId: string;
  readonly #leaseTtlMs: number;

  constructor(
    private readonly queue: DurableRunQueueStore,
    options: DurableRunCoordinatorOptions = {},
  ) {
    this.#instanceId = options.instanceId?.trim() || `run-${randomUUID()}`;
    this.#leaseTtlMs = options.leaseTtlMs ?? 5 * 60_000;
    if (!Number.isSafeInteger(this.#leaseTtlMs)
      || this.#leaseTtlMs < 3_000
      || this.#leaseTtlMs > 86_400_000) {
      throw new Error("Durable run leaseTtlMs must be between 3000 and 86400000");
    }
  }

  recover(): string[] {
    const recovered = this.queue.recoverExpiredLeases();
    for (const record of recovered) this.queue.markRecoveryUnsafe(record.id);
    if (recovered.length > 0) {
      process.stderr.write(`agent.run_queue.quarantined=${String(recovered.length)}\n`);
    }
    return this.queue.pendingConversations();
  }

  enqueue(
    message: IncomingMessage,
    resolved: ResolvedGatewayIdentity,
    projectId?: string,
  ): DurableAgentRunRecord {
    return this.queue.enqueue({
      message,
      resolved,
      ...(projectId ? { projectId } : {}),
    });
  }

  claim(recordId: string): DurableAgentRunRecord | undefined {
    return this.queue.claimById(recordId, this.#instanceId, this.#leaseTtlMs);
  }

  claimNext(conversationId: string): DurableAgentRunRecord | undefined {
    return this.queue.claimNext(
      this.#instanceId,
      this.#leaseTtlMs,
      conversationId,
    );
  }

  pendingCount(conversationId: string): number {
    return this.queue.pendingCount(conversationId);
  }

  cancelPending(conversationId: string): number {
    return this.queue.cancelPending(conversationId);
  }

  async execute(
    record: DurableAgentRunRecord,
    operation: () => Promise<void>,
  ): Promise<void> {
    if (record.transaction.status !== "executing") {
      throw new Error("Durable run must be leased before execution");
    }
    const renewalIntervalMs = Math.max(1_000, Math.floor(this.#leaseTtlMs / 3));
    let leaseLost = false;
    const timer = setInterval(() => {
      if (!this.queue.renewLease(record.id, this.#instanceId, this.#leaseTtlMs)) {
        leaseLost = true;
        process.stderr.write("agent.run_queue.lease=lost\n");
      }
    }, renewalIntervalMs);
    timer.unref?.();
    try {
      await operation();
      if (leaseLost) {
        throw new Error("Durable run lease was lost during execution");
      }
      this.queue.markCompleted(record.id, { handled: true });
    } catch (error) {
      if (!leaseLost) {
        this.queue.markFailed(record.id, errorName(error));
      }
      throw error;
    } finally {
      clearInterval(timer);
    }
  }
}

function errorName(error: unknown): string {
  return error instanceof Error && error.name.trim() ? error.name : "Error";
}
