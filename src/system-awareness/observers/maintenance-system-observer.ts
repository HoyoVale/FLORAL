import { readLatestSystemMaintenanceTransaction } from "../../system-maintenance/system-maintenance.js";
import type { SystemEvidence, SystemObserver } from "../system-types.js";

export interface MaintenanceSystemObserverOptions {
  directory: string;
  now?: (() => Date) | undefined;
}

export class MaintenanceSystemObserver implements SystemObserver {
  readonly id = "maintenance-state";
  readonly componentIds = ["floral.maintenance"] as const;
  readonly #now: () => Date;

  constructor(private readonly options: MaintenanceSystemObserverOptions) {
    this.#now = options.now ?? (() => new Date());
  }

  async observe(): Promise<readonly SystemEvidence[]> {
    const observedAt = this.#now().toISOString();
    const transaction = await readLatestSystemMaintenanceTransaction(this.options.directory);
    return [{
      componentId: "floral.maintenance",
      fact: "last_transaction",
      source: { id: "maintenance-receipt", kind: "filesystem" },
      observedAt,
      confidence: "authoritative",
      scope: "machine",
      value: transaction ? {
        id: transaction.id,
        component_id: transaction.componentId,
        action_id: transaction.actionId,
        status: transaction.status,
        requested_at: transaction.requestedAt,
        updated_at: transaction.updatedAt,
        previous_pid: transaction.previousPid ?? null,
        resulting_pid: transaction.resultingPid ?? null,
        verification: transaction.verification ?? null,
        cancellation_reason: transaction.cancellationReason ?? null,
        error_type: transaction.errorType ?? null,
      } : null,
    }];
  }
}
