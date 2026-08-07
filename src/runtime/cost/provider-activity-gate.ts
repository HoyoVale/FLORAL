import { ModelProviderError } from "../../agent/provider/provider-errors.js";

export class ProviderActivityGate {
  #activeRuns = 0;

  enterAgentRun(): () => void {
    this.#activeRuns += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#activeRuns = Math.max(0, this.#activeRuns - 1);
    };
  }

  assertProviderRequestAllowed(): void {
    if (this.#activeRuns > 0) return;
    throw new ModelProviderError({
      kind: "cost_limit",
      message: "FLORAL blocked an idle DeepSeek request because no agent run is active",
      retryable: false,
      status: 429,
      data: { code: "idle-provider-request" },
    });
  }

  snapshot(): { activeRuns: number; providerAllowed: boolean } {
    return {
      activeRuns: this.#activeRuns,
      providerAllowed: this.#activeRuns > 0,
    };
  }
}
