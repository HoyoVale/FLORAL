import type { DurableOutboxStore } from "../storage/durable-outbox.js";
import type { DurableRunQueueStore } from "../storage/durable-run-queue.js";
import type { DurableStateStore } from "../storage/durable-state.js";

export interface StartupRecoverySnapshot {
  transactionId: string;
  recoveredLeases: number;
  recoveredDeliveries: number;
  recoveredAgentRuns: number;
  deliveryPending: number;
  deliveryFailed: number;
  runPending: number;
  runFailed: number;
  completedAt: number;
}

export class StartupRecoveryCoordinator {
  #latest: StartupRecoverySnapshot | undefined;

  constructor(
    private readonly durability: DurableStateStore,
    private readonly outbox: DurableOutboxStore,
    private readonly runQueue: DurableRunQueueStore,
  ) {}

  recover(): StartupRecoverySnapshot {
    const transaction = this.durability.createTransaction({
      kind: "maintenance",
      correlationId: `startup:${String(process.pid)}`,
      maxAttempts: 1,
      payload: { operation: "startup-recovery" },
    });
    this.durability.transition(transaction.id, {
      status: "accepted",
      eventType: "recovery.accepted",
    });
    this.durability.acquireLease(transaction.id, `recovery:${String(process.pid)}`, 60_000);
    try {
      const recovered = this.durability.recoverExpiredLeases();
      const interruptedRuns = recovered.filter((entry) => entry.kind === "agent-run");
      for (const interrupted of interruptedRuns) {
        const run = this.runQueue.markRecoveryUnsafe(interrupted.id);
        this.outbox.enqueue({
          idempotencyKey: `recovery-notice:agent-run:${interrupted.id}`,
          correlationId: interrupted.id,
          conversationId: run.message.identity.conversationId,
          payload: {
            kind: "text",
            text: "一个任务在执行过程中被服务重启或崩溃中断。为避免重复执行写操作，FLORAL 没有自动重放；请确认结果后重新发送该任务。",
          },
        });
      }
      const outbox = this.outbox.diagnostics();
      const runs = this.runQueue.diagnostics();
      const snapshot: StartupRecoverySnapshot = {
        transactionId: transaction.id,
        recoveredLeases: recovered.length,
        recoveredDeliveries: recovered.filter((entry) => entry.kind === "delivery").length,
        recoveredAgentRuns: interruptedRuns.length,
        deliveryPending: outbox.pending,
        deliveryFailed: outbox.failed,
        runPending: runs.pending,
        runFailed: runs.failed,
        completedAt: Date.now(),
      };
      this.durability.transition(transaction.id, {
        status: "completed",
        eventType: "recovery.completed",
        result: { ...snapshot },
      });
      this.#latest = snapshot;
      process.stderr.write(
        `startup.recovery=completed leases=${String(snapshot.recoveredLeases)} deliveries=${String(snapshot.deliveryPending)} runs=${String(snapshot.runPending)}\n`,
      );
      return snapshot;
    } catch (error) {
      this.durability.transition(transaction.id, {
        status: "failed",
        eventType: "recovery.failed",
        errorCode: error instanceof Error ? error.name : "Error",
      });
      throw error;
    }
  }

  latest(): StartupRecoverySnapshot | undefined {
    return this.#latest;
  }
}
