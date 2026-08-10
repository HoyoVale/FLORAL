import { randomUUID } from "node:crypto";
import type { ChatTransport } from "../core/contracts.js";
import {
  supportsIdempotentTextDelivery,
  supportsMediaTransport,
} from "../core/contracts.js";
import type { DurableOutboxRecord, DurableOutboxStore } from "../storage/durable-outbox.js";
import type { OutgoingMediaMessage } from "../core/types.js";

export interface DeliveryOutboxCoordinatorOptions {
  instanceId?: string | undefined;
  leaseTtlMs?: number | undefined;
  baseRetryMs?: number | undefined;
  maxRetryMs?: number | undefined;
}

export interface QueueTextDeliveryInput {
  conversationId: string;
  text: string;
  idempotencyKey?: string | undefined;
  correlationId?: string | undefined;
  projectId?: string | undefined;
}

export class DeliveryOutboxCoordinator {
  readonly #instanceId: string;
  readonly #leaseTtlMs: number;
  readonly #baseRetryMs: number;
  readonly #maxRetryMs: number;
  #started = false;
  #stopping = false;
  #drainTail: Promise<void> = Promise.resolve();
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly transport: ChatTransport,
    private readonly outbox: DurableOutboxStore,
    options: DeliveryOutboxCoordinatorOptions = {},
  ) {
    this.#instanceId = options.instanceId?.trim() || `delivery-${randomUUID()}`;
    this.#leaseTtlMs = checkedDuration(options.leaseTtlMs ?? 60_000, 1_000, 86_400_000, "leaseTtlMs");
    this.#baseRetryMs = checkedDuration(options.baseRetryMs ?? 2_000, 1, 3_600_000, "baseRetryMs");
    this.#maxRetryMs = checkedDuration(options.maxRetryMs ?? 5 * 60_000, this.#baseRetryMs, 86_400_000, "maxRetryMs");
  }

  async start(): Promise<void> {
    if (this.#started) return;
    if (this.#stopping) throw new Error("Delivery outbox coordinator cannot restart after stop");
    this.#started = true;
    const recovered = this.outbox.recoverExpiredLeases();
    if (recovered.length > 0) {
      process.stderr.write(`delivery.outbox.recovered=${String(recovered.length)}\n`);
    }
    this.#quarantineUnsafeRecovery();
    await this.drain();
  }

  async stop(): Promise<void> {
    if (this.#stopping) return;
    this.#stopping = true;
    this.#started = false;
    this.#clearTimer();
    await this.#drainTail.catch(() => undefined);
  }

  async sendText(input: QueueTextDeliveryInput): Promise<DurableOutboxRecord> {
    if (!this.#started || this.#stopping) {
      throw new Error("Delivery outbox coordinator is not ready");
    }
    const queued = this.outbox.enqueue({
      idempotencyKey: input.idempotencyKey?.trim() || `delivery:${randomUUID()}`,
      conversationId: input.conversationId,
      correlationId: input.correlationId,
      projectId: input.projectId,
      payload: { kind: "text", text: input.text },
    });
    await this.drain();
    return this.outbox.require(queued.id);
  }

  async sendMedia(input: {
    message: OutgoingMediaMessage;
    idempotencyKey?: string | undefined;
    correlationId?: string | undefined;
    projectId?: string | undefined;
  }): Promise<DurableOutboxRecord> {
    if (!this.#started || this.#stopping) {
      throw new Error("Delivery outbox coordinator is not ready");
    }
    const { conversationId, ...media } = input.message;
    const queued = this.outbox.enqueue({
      idempotencyKey: input.idempotencyKey?.trim() || `delivery:${randomUUID()}`,
      conversationId,
      correlationId: input.correlationId,
      projectId: input.projectId,
      payload: { kind: "media", media },
    });
    await this.drain();
    return this.outbox.require(queued.id);
  }

  async drain(): Promise<void> {
    if (!this.#started || this.#stopping) return;
    const run = this.#drainTail
      .catch(() => undefined)
      .then(() => this.#drainNow());
    this.#drainTail = run;
    await run;
  }

  async #drainNow(): Promise<void> {
    this.#clearTimer();
    while (this.#started && !this.#stopping) {
      const record = this.outbox.claimNext(this.#instanceId, this.#leaseTtlMs);
      if (!record) break;
      await this.#deliver(record);
    }
    this.#scheduleNextRetry();
  }

  async #deliver(record: DurableOutboxRecord): Promise<void> {
    try {
      if (record.payload.kind === "text") {
        const message = {
          conversationId: record.conversationId,
          text: record.payload.text,
        };
        if (supportsIdempotentTextDelivery(this.transport)) {
          await this.transport.sendIdempotent(message, record.idempotencyKey);
        } else {
          await this.transport.send(message);
        }
      } else {
        if (!supportsMediaTransport(this.transport)) {
          throw new UnsupportedDeliveryError("transport-media-unsupported");
        }
        await this.transport.sendMedia({
          conversationId: record.conversationId,
          ...record.payload.media,
        });
      }
      this.outbox.markDelivered(record.id, { transport: this.transport.name });
    } catch (error) {
      const errorCode = deliveryErrorCode(error);
      const retrySafe = record.payload.kind === "text"
        && supportsIdempotentTextDelivery(this.transport)
        && !(error instanceof UnsupportedDeliveryError);
      const retryAt = Date.now() + retryDelay(
        record.transaction.attempt,
        this.#baseRetryMs,
        this.#maxRetryMs,
      );
      this.outbox.markAttemptFailed(record.id, errorCode, {
        terminal: !retrySafe,
        ...(retrySafe ? { retryAt } : {}),
      });
      process.stderr.write(
        `delivery.outbox.attempt=failed transport=${this.transport.name} retry_safe=${String(retrySafe)} error=${errorCode}\n`,
      );
    }
  }

  #scheduleNextRetry(): void {
    if (!this.#started || this.#stopping) return;
    const nextRetryAt = this.outbox.listPending(1)[0]?.transaction.nextRetryAt;
    if (nextRetryAt === undefined) return;
    const delay = Math.max(1, Math.min(nextRetryAt - Date.now(), 2_147_483_647));
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.drain().catch((error: unknown) => {
        process.stderr.write(`delivery.outbox.drain=failed error=${deliveryErrorCode(error)}\n`);
      });
    }, delay);
    this.#timer.unref?.();
  }

  #quarantineUnsafeRecovery(): void {
    for (const record of this.outbox.listPending(1_000)) {
      if (record.transaction.attempt < 1) continue;
      const textRetrySafe = record.payload.kind === "text"
        && supportsIdempotentTextDelivery(this.transport);
      if (!textRetrySafe) {
        this.outbox.markRecoveryUnsafe(record.id, "ambiguous-recovery-non-idempotent");
      }
    }
  }

  #clearTimer(): void {
    if (!this.#timer) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}

class UnsupportedDeliveryError extends Error {}

function retryDelay(attempt: number, base: number, maximum: number): number {
  return Math.min(maximum, base * (2 ** Math.max(0, Math.min(attempt - 1, 20))));
}

function deliveryErrorCode(error: unknown): string {
  if (error instanceof UnsupportedDeliveryError) return error.message;
  const name = error instanceof Error && error.name.trim() ? error.name.trim() : "Error";
  return `transport-${name.toLowerCase().replace(/[^a-z0-9-]/gu, "-").slice(0, 120)}`;
}

function checkedDuration(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Delivery outbox ${label} must be between ${String(minimum)} and ${String(maximum)}`);
  }
  return value;
}
