import type {
  AgentStatusSnapshot,
  StatusCardTransport,
} from "../core/contracts.js";
import type { AuditEventInput } from "../core/types.js";

export interface AgentStatusCardControllerOptions {
  transport: StatusCardTransport;
  audit: (event: AuditEventInput) => Promise<void>;
  enabled: boolean;
  updateIntervalMs: number;
  autoPin: boolean;
  now?: (() => number) | undefined;
  schedule?: ((callback: () => void, delayMs: number) => unknown) | undefined;
  cancelSchedule?: ((handle: unknown) => void) | undefined;
}

interface CardState {
  conversationId: string;
  messageId: string;
  pinned: boolean;
  startedAt: number;
  lastUpdateAt: number;
  timer?: unknown | undefined;
  snapshot: AgentStatusSnapshot;
}

type ResolvedAgentStatusCardOptions = Omit<
  AgentStatusCardControllerOptions,
  "now" | "schedule" | "cancelSchedule"
> & {
  now: () => number;
  schedule: (callback: () => void, delayMs: number) => unknown;
  cancelSchedule: (handle: unknown) => void;
};

export class AgentStatusCardController {
  readonly #options: ResolvedAgentStatusCardOptions;
  readonly #cards = new Map<string, CardState>();
  #started = false;
  #stopped = false;

  constructor(options: AgentStatusCardControllerOptions) {
    this.#options = {
      ...options,
      now: options.now ?? (() => Date.now()),
      schedule: options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs)),
      cancelSchedule: options.cancelSchedule
        ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)),
    };
  }

  async start(): Promise<void> {
    if (this.#started) return;
    if (this.#stopped) throw new Error("Status card controller cannot restart after stop");
    this.#started = true;
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#started = false;
    for (const state of this.#cards.values()) {
      this.#cancelTimer(state);
    }
    this.#cards.clear();
  }

  hasCard(conversationId: string): boolean {
    return this.#cards.has(conversationId);
  }

  messageIdFor(conversationId: string): string | undefined {
    return this.#cards.get(conversationId)?.messageId;
  }

  async onRunStarted(
    conversationId: string,
    snapshot: AgentStatusSnapshot,
  ): Promise<void> {
    if (!this.#started || this.#stopped || !this.#options.enabled) return;
    const existing = this.#cards.get(conversationId);
    if (!existing) {
      const startedAt = this.#options.now();
      const sent = await this.#safe("send", async () => {
        const result = await this.#options.transport.sendStatusCard(conversationId, snapshot);
        const state: CardState = {
          conversationId,
          messageId: result.messageId,
          pinned: false,
          startedAt,
          lastUpdateAt: startedAt,
          snapshot,
        };
        this.#cards.set(conversationId, state);
        if (this.#options.autoPin) await this.#pin(state);
        this.#armTimer(state);
      });
      if (!sent) return;
      return;
    }
    existing.startedAt = this.#options.now();
    existing.snapshot = snapshot;
    await this.#update(existing, true);
    if (this.#options.autoPin && !existing.pinned) await this.#pin(existing);
    this.#armTimer(existing);
  }

  async onRunEvent(
    conversationId: string,
    snapshot: AgentStatusSnapshot,
  ): Promise<void> {
    const state = this.#cards.get(conversationId);
    if (!state) return;
    state.snapshot = { ...state.snapshot, ...snapshot };
    if (this.#options.now() - state.lastUpdateAt < this.#options.updateIntervalMs) return;
    await this.#update(state, false);
  }

  async onCooldown(
    conversationId: string,
    snapshot: AgentStatusSnapshot,
  ): Promise<void> {
    const state = this.#cards.get(conversationId);
    if (!state) return;
    state.snapshot = { ...state.snapshot, ...snapshot };
    await this.#update(state, true);
    if (this.#options.autoPin && !state.pinned) await this.#pin(state);
  }

  async onRunEnded(
    conversationId: string,
    snapshot: AgentStatusSnapshot,
  ): Promise<void> {
    const state = this.#cards.get(conversationId);
    if (!state) return;
    state.snapshot = { ...state.snapshot, ...snapshot };
    this.#cancelTimer(state);
    await this.#update(state, true);
  }

  async onStopped(
    conversationId: string,
    snapshot: AgentStatusSnapshot,
  ): Promise<void> {
    const state = this.#cards.get(conversationId);
    if (!state) return;
    state.snapshot = { ...state.snapshot, ...snapshot };
    this.#cancelTimer(state);
    await this.#update(state, true);
    await this.#unpin(state);
  }

  async onUserInterrupt(conversationId: string): Promise<void> {
    const state = this.#cards.get(conversationId);
    if (!state) return;
    this.#cancelTimer(state);
    await this.#unpin(state);
  }

  async #update(state: CardState, force: boolean): Promise<void> {
    const elapsedMs = this.#options.now() - state.startedAt;
    const snapshot: AgentStatusSnapshot = {
      ...state.snapshot,
      elapsedMs,
    };
    state.lastUpdateAt = this.#options.now();
    await this.#safe("update", () =>
      this.#options.transport.updateStatusCard(state.messageId, snapshot));
  }

  async #pin(state: CardState): Promise<void> {
    if (state.pinned) return;
    await this.#safe("pin", async () => {
      await this.#options.transport.pinStatusCard(state.messageId);
      state.pinned = true;
    });
  }

  async #unpin(state: CardState): Promise<void> {
    if (!state.pinned) return;
    await this.#safe("unpin", async () => {
      await this.#options.transport.unpinStatusCard(state.messageId);
      state.pinned = false;
    });
  }

  #armTimer(state: CardState): void {
    this.#cancelTimer(state);
    state.timer = this.#options.schedule(
      () => this.#tick(state),
      this.#options.updateIntervalMs,
    );
  }

  async #tick(state: CardState): Promise<void> {
    if (!this.#cards.has(state.conversationId)) return;
    if (this.#options.now() - state.lastUpdateAt < this.#options.updateIntervalMs) {
      this.#armTimer(state);
      return;
    }
    await this.#update(state, false);
    this.#armTimer(state);
  }

  #cancelTimer(state: CardState): void {
    if (state.timer === undefined) return;
    this.#options.cancelSchedule(state.timer);
    state.timer = undefined;
  }

  async #safe(phase: string, action: () => Promise<void>): Promise<boolean> {
    try {
      await action();
      return true;
    } catch (error) {
      await this.#options.audit({
        eventType: "feishu.status_card_failed",
        payload: {
          phase,
          errorType: error instanceof Error ? error.name : "Error",
        },
      }).catch(() => undefined);
      return false;
    }
  }
}
