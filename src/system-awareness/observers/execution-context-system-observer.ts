import type {
  SystemEvidence,
  SystemObservationContext,
  SystemObserver,
} from "../system-types.js";
import { evidence } from "./observer-utils.js";

export interface ExecutionContextSystemObserverOptions {
  now?: (() => Date) | undefined;
}

export class ExecutionContextSystemObserver implements SystemObserver {
  readonly id = "execution-context";
  readonly componentIds = ["floral.execution"] as const;
  readonly #now: () => Date;

  constructor(options: ExecutionContextSystemObserverOptions = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  async observe(context: SystemObservationContext): Promise<readonly SystemEvidence[]> {
    const observedAt = this.#now().toISOString();
    const output: SystemEvidence[] = [];
    const gateway = context.execution?.gateway;
    if (gateway) {
      output.push(
        contextEvidence("gateway.control_mode", gateway.controlMode, observedAt, "gateway-execution-policy", "conversation"),
        contextEvidence("gateway.requested_sandbox", gateway.sandboxMode, observedAt, "gateway-execution-policy", "conversation"),
        contextEvidence("gateway.requested_approval_policy", gateway.approvalPolicy, observedAt, "gateway-execution-policy", "conversation"),
        contextEvidence("gateway.requested_approvals_reviewer", gateway.approvalsReviewer, observedAt, "gateway-execution-policy", "conversation"),
        contextEvidence("gateway.approval_route", gateway.approvalRoute ?? "unknown", observedAt, "gateway-execution-policy", "conversation"),
      );
    }

    const turn = context.execution?.turn;
    if (turn) {
      output.push(
        contextEvidence("turn.selector", turn.selector, observedAt, "codex-turn-execution", "runtime"),
        contextEvidence("turn.sandbox_mode", turn.sandboxMode, observedAt, "codex-turn-execution", "runtime"),
        contextEvidence("turn.permission_profile", turn.permissionProfile, observedAt, "codex-turn-execution", "runtime"),
        contextEvidence("turn.approval_policy", turn.approvalPolicy, observedAt, "codex-turn-execution", "runtime"),
        contextEvidence("turn.approvals_reviewer", turn.approvalsReviewer, observedAt, "codex-turn-execution", "runtime"),
      );
    }
    return output;
  }
}

function contextEvidence(
  fact: string,
  value: string,
  observedAt: string,
  sourceId: string,
  scope: "conversation" | "runtime",
): SystemEvidence {
  return evidence({
    componentId: "floral.execution",
    fact,
    sourceId,
    sourceKind: "runtime-context",
    confidence: value === "unknown" ? "unknown" : "authoritative",
    scope,
    value: value === "unknown" ? null : value,
    observedAt,
    ...(value === "unknown" ? { reason: "gateway-route-unavailable" } : {}),
  });
}
