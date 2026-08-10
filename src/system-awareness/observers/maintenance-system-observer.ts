import { readLatestSystemMaintenanceTransaction } from "../../system-maintenance/system-maintenance.js";
import {
  readMaintenanceAutonomyStatus,
  type MaintenanceAutonomyMachinePolicy,
} from "../../system-maintenance/maintenance-autonomy.js";
import type { SystemEvidence, SystemObserver } from "../system-types.js";

export interface MaintenanceSystemObserverOptions {
  directory: string;
  autonomy?: MaintenanceAutonomyMachinePolicy | undefined;
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
    const now = this.#now();
    const observedAt = now.toISOString();
    const [transaction, autonomy] = await Promise.all([
      readLatestSystemMaintenanceTransaction(this.options.directory),
      readMaintenanceAutonomyStatus(this.options.directory, this.options.autonomy ?? {
        ceiling: "manual",
        allowedActions: ["floral.service.restart"],
        maxAutomaticActionsPerHour: 2,
        cooldownMs: 300_000,
        failureThreshold: 2,
        selfHealIntervalMs: 60_000,
      }, now),
    ]);
    return [
      {
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
          trigger: transaction.trigger ?? "manual",
          diagnostic_finding_ids: transaction.diagnosticFindingIds ?? [],
          notification_status: transaction.notificationStatus ?? null,
          repair_outcome: transaction.repairOutcome ?? null,
        } : null,
      },
      {
        componentId: "floral.maintenance",
        fact: "autonomy_policy",
        source: { id: "maintenance-autonomy-policy", kind: "filesystem" },
        observedAt,
        confidence: "authoritative",
        scope: "machine",
        value: {
          requested_mode: autonomy.requestedMode,
          effective_mode: autonomy.effectiveMode,
          machine_ceiling: autonomy.ceiling,
          allowed_actions: [...autonomy.allowedActions],
          max_automatic_actions_per_hour: autonomy.maxAutomaticActionsPerHour,
          cooldown_ms: autonomy.cooldownMs,
          failure_threshold: autonomy.failureThreshold,
          self_heal_interval_ms: autonomy.selfHealIntervalMs,
        },
      },
      {
        componentId: "floral.maintenance",
        fact: "autonomy_state",
        source: { id: "maintenance-autonomy-policy", kind: "filesystem" },
        observedAt,
        confidence: "authoritative",
        scope: "machine",
        value: {
          recent_automatic_actions: autonomy.recentAutomaticActions,
          consecutive_self_heal_failures: autonomy.consecutiveSelfHealFailures,
          circuit_breaker_open: autonomy.circuitBreakerOpen,
          last_automatic_action_at: autonomy.lastAutomaticActionAt ?? null,
          owner_notification_target_present: Boolean(autonomy.lastOwnerDeliveryConversationId),
        },
      },
    ];
  }
}
