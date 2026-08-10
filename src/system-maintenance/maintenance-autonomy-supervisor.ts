import type { GatewayStore } from "../core/contracts.js";
import type { SystemAwarenessReadProvider } from "../system-awareness/system-read-interface.js";
import { buildSystemDiagnosticReport, type SystemDiagnosticReport } from "../system-awareness/system-diagnostics.js";
import type { SystemMaintenanceController, SystemMaintenanceTransaction } from "./system-maintenance.js";

export interface MaintenanceAutonomySupervisorOptions {
  controller: SystemMaintenanceController;
  systemAwareness: SystemAwarenessReadProvider;
  cwd: string;
  store?: GatewayStore | undefined;
  notify?: ((conversationId: string, text: string) => Promise<void>) | undefined;
  now?: (() => Date) | undefined;
  startupGraceMs?: number | undefined;
}

export interface SelfHealRepairDecision {
  componentId: "floral.service";
  actionId: "restart";
  rationale: string;
  findingIds: string[];
}

export class MaintenanceAutonomySupervisor {
  readonly #controller: SystemMaintenanceController;
  readonly #systemAwareness: SystemAwarenessReadProvider;
  readonly #cwd: string;
  readonly #store: GatewayStore | undefined;
  readonly #notify: ((conversationId: string, text: string) => Promise<void>) | undefined;
  readonly #now: () => Date;
  readonly #startupGraceMs: number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopped = false;
  #running = false;

  constructor(options: MaintenanceAutonomySupervisorOptions) {
    this.#controller = options.controller;
    this.#systemAwareness = options.systemAwareness;
    this.#cwd = options.cwd;
    this.#store = options.store;
    this.#notify = options.notify;
    this.#now = options.now ?? (() => new Date());
    this.#startupGraceMs = options.startupGraceMs ?? 30_000;
  }

  start(): void {
    if (this.#timer || this.#stopped) return;
    this.#schedule(this.#startupGraceMs);
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  async runOnce(): Promise<void> {
    if (this.#running || this.#stopped) return;
    this.#running = true;
    try {
      // Do not poll Codex/System Awareness every interval while autonomy is
      // manual/owner-auto. A fresh model is required only to reconcile a
      // verified Self-Heal repair or to evaluate new Self-Heal rules.
      const initialPolicy = await this.#controller.autonomyStatus();
      const latest = await this.#controller.readLatest();
      const needsVerifiedRepairReconciliation = latest?.trigger === "self-heal"
        && latest.status === "verified"
        && !latest.repairOutcome
        && (latest.diagnosticFindingIds?.length ?? 0) > 0;
      const mayEvaluateSelfHeal = initialPolicy.effectiveMode === "self-heal"
        && !initialPolicy.circuitBreakerOpen;

      let report: SystemDiagnosticReport | undefined;
      if (needsVerifiedRepairReconciliation || mayEvaluateSelfHeal) {
        const model = await this.#systemAwareness.read({ cwd: this.#cwd });
        report = buildSystemDiagnosticReport(model);
      }
      if (needsVerifiedRepairReconciliation && report) {
        await this.#controller.reconcileSelfHealOutcome(
          report.findings.map((finding) => finding.id),
        );
      }

      await this.#deliverPendingNotification();

      const policy = await this.#controller.autonomyStatus();
      if (policy.effectiveMode !== "self-heal" || policy.circuitBreakerOpen) return;
      const allowance = await this.#controller.automaticApprovalAllowed("self-heal");
      if (!allowance.allowed) return;

      if (!report) {
        const model = await this.#systemAwareness.read({ cwd: this.#cwd });
        report = buildSystemDiagnosticReport(model);
      }
      const decision = selectSelfHealRepair(report);
      if (!decision) return;

      const prepared = await this.#controller.prepare({
        componentId: decision.componentId,
        actionId: decision.actionId,
        rationale: decision.rationale,
      }, {
        trigger: "self-heal",
        diagnosticFindingIds: decision.findingIds,
      });
      if (prepared.result.status !== "queued" || !prepared.transactionId) return;

      await this.#audit("system.maintenance_self_heal_queued", {
        transactionId: prepared.transactionId,
        findingIds: decision.findingIds,
      });
      await this.#controller.execute(prepared.transactionId);
      await this.#audit("system.maintenance_self_heal_handoff", {
        transactionId: prepared.transactionId,
      });
    } catch (error) {
      await this.#audit("system.maintenance_self_heal_error", {
        errorType: error instanceof Error ? error.name : "Error",
      });
    } finally {
      this.#running = false;
    }
  }

  #schedule(delayMs: number): void {
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.runOnce().finally(async () => {
        if (this.#stopped) return;
        const policy = await this.#controller.autonomyStatus().catch(() => undefined);
        this.#schedule(policy?.selfHealIntervalMs ?? 60_000);
      });
    }, delayMs);
    this.#timer.unref?.();
  }

  async #deliverPendingNotification(): Promise<void> {
    const notify = this.#notify;
    if (!notify) return;
    const transaction = await this.#controller.pendingSelfHealNotification();
    if (!transaction) return;
    const policy = await this.#controller.autonomyStatus();
    const conversationId = policy.lastOwnerDeliveryConversationId;
    if (!conversationId) return;
    const text = formatSelfHealNotification(transaction, policy.circuitBreakerOpen);
    try {
      await notify(conversationId, text);
      await this.#controller.markNotificationDelivered(transaction.id, true);
      await this.#audit("system.maintenance_self_heal_notified", {
        transactionId: transaction.id,
        status: transaction.status,
      });
    } catch (error) {
      await this.#controller.markNotificationDelivered(transaction.id, false).catch(() => undefined);
      await this.#audit("system.maintenance_self_heal_notification_failed", {
        transactionId: transaction.id,
        errorType: error instanceof Error ? error.name : "Error",
      });
    }
  }

  async #audit(eventType: string, payload: Record<string, unknown>): Promise<void> {
    await this.#store?.appendAudit({ eventType, payload }).catch(() => undefined);
  }
}

export function selectSelfHealRepair(report: SystemDiagnosticReport): SelfHealRepairDecision | undefined {
  const eligible = report.findings.filter((finding) =>
    finding.confidence === "high"
    && finding.severity === "error"
    && finding.componentId?.startsWith("mcp.floral_")
    && (finding.id.endsWith(".runtime-failed") || finding.id.endsWith(".runtime-cancelled"))
  );
  if (eligible.length === 0) return undefined;
  const findingIds = eligible.slice(0, 4).map((finding) => finding.id);
  return {
    componentId: "floral.service",
    actionId: "restart",
    rationale: `self-heal: high-confidence built-in MCP runtime failure (${findingIds.join(", ")})`,
    findingIds,
  };
}

function formatSelfHealNotification(
  transaction: SystemMaintenanceTransaction,
  circuitBreakerOpen: boolean,
): string {
  if (transaction.status === "verified" && transaction.repairOutcome === "resolved") {
    return [
      "FLORAL Self-Heal 已完成并通过故障复核。",
      `事务=${transaction.id}`,
      `动作=${transaction.componentId}/${transaction.actionId}`,
      `PID=${transaction.previousPid ?? "unknown"} -> ${transaction.resultingPid ?? "unknown"}`,
      `验证=${transaction.verification ?? "unknown"}`,
      "repair_outcome=resolved",
      "原始高置信度诊断 finding 已在 fresh snapshot 中消失。",
      "该操作由机器预授权的 self-heal 策略触发，不包含通用 shell 回退。",
    ].join("\n");
  }
  if (transaction.status === "verified" && transaction.repairOutcome === "persistent") {
    return [
      "FLORAL Self-Heal 已完成重启动作，但目标故障仍然存在。",
      `事务=${transaction.id}`,
      `动作=${transaction.componentId}/${transaction.actionId}`,
      `PID=${transaction.previousPid ?? "unknown"} -> ${transaction.resultingPid ?? "unknown"}`,
      `验证=${transaction.verification ?? "unknown"}`,
      "repair_outcome=persistent",
      `circuit_breaker=${circuitBreakerOpen ? "open" : "closed"}`,
      circuitBreakerOpen
        ? "连续自动恢复未解决目标故障达到阈值，Self-Heal 已停止继续自动重试，需要主人检查。"
        : "系统不会把“重启成功”误报为“故障修复成功”；后续重试仍受 cooldown/rate-limit 约束。",
    ].join("\n");
  }
  return [
    "FLORAL Self-Heal 的受管维护动作未能完成验证。",
    `事务=${transaction.id}`,
    `状态=${transaction.status}`,
    `repair_outcome=${transaction.repairOutcome ?? "action-failed"}`,
    `错误类型=${transaction.errorType ?? "unknown"}`,
    `circuit_breaker=${circuitBreakerOpen ? "open" : "closed"}`,
    circuitBreakerOpen
      ? "连续自动恢复失败达到阈值，Self-Heal 已停止继续自动重试，需要主人检查。"
      : "系统不会绕过治理边界执行其他修复。",
  ].join("\n");
}
