import type {
  AgentApprovalHandler,
  AgentApprovalRequest,
  AgentSystemMaintenanceHandler,
  AgentSystemMaintenanceResult,
} from "../core/types.js";
import {
  SystemDefinitionRegistry,
  buildSystemDiagnosticReport,
  formatSystemCapabilities,
  formatSystemComponentStatus,
  formatSystemDiagnostics,
  formatSystemRuntimeContext,
  formatSystemSummary,
  type SystemDefinition,
  type SystemObservationContext,
  type SystemReadModel,
  type SystemSnapshot,
} from "../system-awareness/index.js";

export interface CodexSystemAwarenessOptions {
  definitions: readonly SystemDefinition[];
  snapshotProvider: (context: SystemObservationContext) => Promise<SystemSnapshot>;
}

export interface FloralSystemToolCall {
  threadId: string;
  tool: string;
  callId: string;
  arguments: Record<string, unknown>;
  approvalHandler?: AgentApprovalHandler | undefined;
  maintenanceHandler?: AgentSystemMaintenanceHandler | undefined;
  onApprovalRequested?: ((request: AgentApprovalRequest) => void) | undefined;
}

export interface FloralSystemToolResult {
  success: boolean;
  text: string;
}

export class FloralSystemToolController {
  readonly #registry: SystemDefinitionRegistry | undefined;
  readonly #snapshotProvider: CodexSystemAwarenessOptions["snapshotProvider"] | undefined;
  readonly #snapshots = new Map<string, SystemSnapshot>();

  constructor(options?: CodexSystemAwarenessOptions | undefined) {
    this.#registry = options
      ? new SystemDefinitionRegistry(options.definitions)
      : undefined;
    this.#snapshotProvider = options?.snapshotProvider;
  }

  get enabled(): boolean {
    return Boolean(this.#registry && this.#snapshotProvider);
  }

  getSnapshot(threadId: string): SystemSnapshot | undefined {
    return this.#snapshots.get(threadId);
  }

  clearThread(threadId: string): void {
    this.#snapshots.delete(threadId);
  }

  clear(): void {
    this.#snapshots.clear();
  }

  async captureSnapshot(
    threadId: string,
    cwd: string,
    execution?: SystemObservationContext["execution"],
  ): Promise<void> {
    const provider = this.#snapshotProvider;
    const registry = this.#registry;
    if (!provider || !registry) return;
    try {
      const snapshot = await provider({
        cwd,
        threadId,
        ...(execution ? { execution } : {}),
      });
      if (snapshot.definitionFingerprint !== registry.fingerprint()) {
        throw new Error("System snapshot definition fingerprint mismatch");
      }
      this.#snapshots.set(threadId, snapshot);
      process.stderr.write(
        `agent.stack.system_awareness.snapshot=ok:${String(snapshot.components.length)}\n`,
      );
    } catch (error) {
      this.#snapshots.delete(threadId);
      process.stderr.write(
        `agent.stack.system_awareness.snapshot=failed:${safeToken(
          error instanceof Error ? error.name : "Error",
        )}\n`,
      );
    }
  }

  async handle(call: FloralSystemToolCall): Promise<FloralSystemToolResult> {
    const registry = this.#registry;
    const snapshot = this.#snapshots.get(call.threadId);
    if (!registry || !snapshot) {
      return failed("system_awareness=unavailable\nreason=invalid-context-or-snapshot");
    }
    const model: SystemReadModel = { definitions: registry.list(), snapshot };
    try {
      if (call.tool === "current_context") {
        return ok(boundedToolText(formatSystemRuntimeContext(model)));
      }
      if (call.tool === "system_summary") {
        return ok(boundedToolText(formatSystemSummary(model)));
      }
      if (call.tool === "component_status") {
        const componentId = readString(call.arguments.component_id);
        if (!componentId || !registry.has(componentId)) {
          return failed("system_awareness=denied\nreason=unknown-component");
        }
        return ok(boundedToolText(formatSystemComponentStatus(model, componentId)));
      }
      if (call.tool === "diagnose") {
        const rawComponentId = call.arguments.component_id;
        const componentId = rawComponentId === undefined
          ? undefined
          : readString(rawComponentId);
        if (rawComponentId !== undefined && (!componentId || !registry.has(componentId))) {
          return failed("system_awareness=denied\nreason=unknown-component");
        }
        return ok(boundedToolText(formatSystemDiagnostics(model, componentId)));
      }
      if (call.tool === "maintain") {
        return await this.#maintain(call, model, registry);
      }
      if (call.tool === "capabilities") {
        const rawComponentId = call.arguments.component_id;
        const componentId = rawComponentId === undefined
          ? undefined
          : readString(rawComponentId);
        if (rawComponentId !== undefined && (!componentId || !registry.has(componentId))) {
          return failed("system_awareness=denied\nreason=unknown-component");
        }
        return ok(boundedToolText(formatSystemCapabilities(model, componentId)));
      }
    } catch (error) {
      return failed(
        `system_awareness=failed\nreason=${safeToken(error instanceof Error ? error.name : "Error")}`,
      );
    }
    return failed("system_awareness=denied\nreason=unsupported-tool");
  }

  async #maintain(
    call: FloralSystemToolCall,
    model: SystemReadModel,
    registry: SystemDefinitionRegistry,
  ): Promise<FloralSystemToolResult> {
    const componentId = readString(call.arguments.component_id);
    const actionId = readString(call.arguments.action_id);
    const rationale = readString(call.arguments.rationale)?.trim();
    const definition = componentId && registry.has(componentId)
      ? registry.require(componentId)
      : undefined;
    const action = definition?.managementActions.find((candidate) => candidate.id === actionId);
    if (
      componentId !== "floral.service"
      || actionId !== "restart"
      || !rationale
      || rationale.length > 320
      || !action
      || action.disposition !== "host-only"
      || action.approval !== "autonomy-policy"
      || action.capability !== "system.restart"
      || !call.approvalHandler
      || !call.maintenanceHandler
    ) {
      return failed("system_maintenance=denied\nreason=invalid-or-undeclared-action");
    }

    const preflight = buildSystemDiagnosticReport(model, componentId);
    const approval: AgentApprovalRequest = {
      requestId: `maintenance-${safeToken(call.callId)}`,
      kind: "system-maintenance",
      capability: "system.restart",
      summary: [
        "FLORAL Agent 请求执行受治理的系统维护。",
        `component=${componentId}`,
        `action=${actionId}`,
        `diagnostic_status=${preflight.overallStatus}`,
        `diagnostic_findings=${preflight.findings.length}`,
        `rationale=${rationale.slice(0, 180)}`,
        "execution=post-reply-handoff",
        "verification=maintenance-receipt-next-turn",
      ].join(" "),
      source: "floral",
    };
    call.onApprovalRequested?.(approval);
    const decision = await call.approvalHandler(approval).catch(() => "deny" as const);
    if (decision !== "approve") {
      return failed("system_maintenance=denied\nreason=local-confirmation");
    }
    const result: AgentSystemMaintenanceResult = await call.maintenanceHandler({
      componentId,
      actionId,
      rationale,
    }).catch((error): AgentSystemMaintenanceResult => ({
      status: "failed",
      reason: safeToken(error instanceof Error ? error.name : "Error"),
    }));
    if (result.status !== "queued") {
      return failed([
        `system_maintenance=${result.status}`,
        `reason=${safeToken(result.reason)}`,
        ...(result.transactionId ? [`transaction_id=${safeToken(result.transactionId)}`] : []),
      ].join("\n"));
    }
    return ok([
      "system_maintenance=queued",
      `component=${componentId}`,
      `action=${actionId}`,
      `transaction_id=${safeToken(result.transactionId)}`,
      `diagnostic_status=${preflight.overallStatus}`,
      `diagnostic_findings=${preflight.findings.length}`,
      "execution_performed=false",
      "handoff=after-agent-reply",
      "verification=pending-next-service-instance",
      "next=use-floral_system/component_status-floral.maintenance-on-a-fresh-turn",
    ].join("\n"));
  }
}

function ok(text: string): FloralSystemToolResult {
  return { success: true, text };
}

function failed(text: string): FloralSystemToolResult {
  return { success: false, text };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function boundedToolText(value: string): string {
  const normalized = value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, " ")
    .trim();
  return normalized.length <= 12_000
    ? normalized
    : `${normalized.slice(0, 11_980)}\ntruncated=true`;
}

function safeToken(value: string | undefined): string {
  const normalized = (value ?? "")
    .replace(/[^A-Za-z0-9._:-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return normalized.slice(0, 96) || "unknown";
}
