import type {
  ChatTransport,
  GatewayStore,
} from "../core/contracts.js";
import type {
  AuditEventInput,
  ExternalIdentity,
  IncomingMessage,
  OutgoingMessage,
  ResolvedGatewayIdentity,
  TransportKind,
} from "../core/types.js";

export interface FullChainStoreSnapshot {
  ownerPaired: boolean;
  runRequested: boolean;
  runCompleted: boolean;
  runFailed: boolean;
  threadBeforeRun?: string | undefined;
  threadAfterRun?: string | undefined;
}

export class FullChainObservedStore implements GatewayStore {
  #ownerPaired = false;
  #runRequested = false;
  #runCompleted = false;
  #runFailed = false;
  #threadBeforeRun: string | undefined;
  #threadBeforeCaptured = false;
  #threadAfterRun: string | undefined;

  constructor(private readonly delegate: GatewayStore) {}

  snapshot(): FullChainStoreSnapshot {
    return {
      ownerPaired: this.#ownerPaired,
      runRequested: this.#runRequested,
      runCompleted: this.#runCompleted,
      runFailed: this.#runFailed,
      threadBeforeRun: this.#threadBeforeRun,
      threadAfterRun: this.#threadAfterRun,
    };
  }

  async resolveIdentity(
    identity: ExternalIdentity,
  ): Promise<ResolvedGatewayIdentity | undefined> {
    return await this.delegate.resolveIdentity(identity);
  }

  async claimOwner(identity: ExternalIdentity): Promise<ResolvedGatewayIdentity> {
    const resolved = await this.delegate.claimOwner(identity);
    this.#ownerPaired = true;
    return resolved;
  }

  async hasOwner(transport: TransportKind, botId: string): Promise<boolean> {
    return await this.delegate.hasOwner(transport, botId);
  }

  async acceptMessage(
    identity: ExternalIdentity,
    messageId: string,
    receivedAt: Date,
  ): Promise<boolean> {
    return await this.delegate.acceptMessage(identity, messageId, receivedAt);
  }

  async getActiveThread(conversationId: string): Promise<string | undefined> {
    const threadId = await this.delegate.getActiveThread(conversationId);
    if (this.#runRequested && !this.#threadBeforeCaptured) {
      this.#threadBeforeCaptured = true;
      this.#threadBeforeRun = threadId;
    }
    return threadId;
  }

  async setActiveThread(conversationId: string, threadId: string): Promise<void> {
    await this.delegate.setActiveThread(conversationId, threadId);
    this.#threadAfterRun = threadId;
  }

  async clearActiveThread(conversationId: string): Promise<void> {
    await this.delegate.clearActiveThread(conversationId);
  }

  async appendAudit(event: AuditEventInput): Promise<void> {
    if (event.eventType === "agent.run_requested") this.#runRequested = true;
    if (event.eventType === "agent.run_completed") this.#runCompleted = true;
    if (event.eventType === "agent.run_failed") this.#runFailed = true;
    await this.delegate.appendAudit(event);
  }

  async close(): Promise<void> {
    await this.delegate.close();
  }
}

export interface FullChainTransportSnapshot {
  markerDelivered: boolean;
  outboundMessages: number;
}

export class FullChainObservedTransport implements ChatTransport {
  readonly name: string;
  #markerDelivered = false;
  #outboundMessages = 0;
  readonly #markerPromise: Promise<void>;
  #resolveMarker!: () => void;

  constructor(
    private readonly delegate: ChatTransport,
    private readonly expectedMarker: string,
  ) {
    this.name = delegate.name;
    this.#markerPromise = new Promise<void>((resolvePromise) => {
      this.#resolveMarker = resolvePromise;
    });
  }

  snapshot(): FullChainTransportSnapshot {
    return {
      markerDelivered: this.#markerDelivered,
      outboundMessages: this.#outboundMessages,
    };
  }

  async start(
    onMessage: (message: IncomingMessage) => Promise<void>,
  ): Promise<void> {
    await this.delegate.start(onMessage);
  }

  async send(message: OutgoingMessage): Promise<void> {
    await this.delegate.send(message);
    this.#outboundMessages += 1;
    if (
      !this.#markerDelivered
      && message.text.trim() === this.expectedMarker
    ) {
      this.#markerDelivered = true;
      this.#resolveMarker();
    }
  }

  async stop(): Promise<void> {
    await this.delegate.stop();
  }

  async waitForMarker(timeoutMs: number): Promise<void> {
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error("Full-chain marker timeout must be a positive integer");
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.#markerPromise,
        new Promise<void>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Full-chain marker timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
