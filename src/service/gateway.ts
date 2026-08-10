import { resolve } from "node:path";
import {
  supportsAgentExtensionDiscovery,
  supportsAgentSkills,
  supportsAgentThreadManagement,
  supportsConversationActivity,
  supportsInteractiveApproval,
  supportsWorkspaceStateStore,
  type AgentRuntime,
  type AgentThreadSummary,
  type ChatTransport,
  type ConversationActivityState,
  type GatewayStore,
  supportsInboundAttachmentMaterializer,
  supportsConversationControlState,
} from "../core/contracts.js";
import type {
  AgentApprovalDecision,
  AgentApprovalRequest,
  AgentEvent,
  IncomingMessage,
  ResolvedGatewayIdentity,
} from "../core/types.js";
import {
  PairingAttemptLimiter,
  pairingCodeMatches,
  parseGatewayCommand,
  type GatewayCommand,
} from "./gateway-commands.js";
import type { AuthorizationAuthority } from "../policy/authorization-authority.js";
import { QqApprovalBroker } from "../policy/qq-approval-broker.js";
import type { LocalConfirmationBroker } from "../policy/local-confirmation-broker.js";
import type { SystemMaintenanceController } from "../system-maintenance/system-maintenance.js";
import { isExplicitOwnerServiceRestartRequest, type MaintenanceAutonomyMode } from "../system-maintenance/maintenance-autonomy.js";
import {
  formatSystemComponentStatus,
  formatSystemDiagnostics,
  formatSystemDiagnosticsSummary,
  formatSystemSummary,
  type SystemAwarenessReadProvider,
} from "../system-awareness/index.js";
import type {
  ArtifactEgressPolicy,
  ArtifactEgressRunBudget,
} from "../policy/artifact-egress-policy.js";
import {
  formatAgentApps,
  formatAgentMcpServers,
  formatAgentSkills,
  formatGatewayStatus,
  formatNativePluginStatus,
  formatNativeMemoryDiagnostics,
  formatNativeMemoryStatus,
  gatewayHelpText,
} from "./gateway-status.js";
import {
  projectRuntimeNamespace,
  type ProjectWorkspaceRoot,
  type WorkspaceProject,
} from "../workspace/project-workspace.js";
import {
  bootstrapProjectContext,
  inspectProjectContext,
  inspectProjectMemory,
  recordProjectMemory,
} from "../workspace/project-context.js";
import { ArtifactEgressController } from "./artifact-egress-controller.js";
import { assertDurableAttachmentsAvailable } from "./durable-attachment-spool.js";
import type { DeliveryOutboxCoordinator } from "./delivery-outbox-coordinator.js";
import type { DurableRunCoordinator } from "./durable-run-coordinator.js";
import type { DurableAgentRunRecord } from "../storage/durable-run-queue.js";
import type { StartupRecoveryCoordinator } from "./startup-recovery-coordinator.js";
import {
  agentFailureUserMessage,
  approvalCommandReply,
  executionPolicyForMode,
  formatProjectContextStatus,
  formatProjectMemoryStatus,
  formatSafeAgentFailure,
  formatThreadPreview,
  humanizeProjectMemoryKind,
  maintenancePolicyText,
  modeChangedText,
  modeStatusText,
  renderIncomingMessageForAgent,
  safeLogToken,
  visibleActivityProgress,
  type AgentControlMode,
} from "./gateway-presentation.js";
import { handleGatewayGoalCommand } from "./gateway-goals.js";
import { listGatewayChats } from "./gateway-chats.js";
export interface GatewayOptions {
  cwd: string;
  workspace?: ProjectWorkspaceRoot | undefined;
  model?: string;
  ownerPairingCode?: string;
  trustMockOwner?: boolean;
  runtimeStatusLines?: ((cwd: string) => Promise<string[]>) | undefined;
  nativeMemoryDiagnosticLines?: ((cwd: string) => Promise<string[]>) | undefined;
  conversationUx?: {
    visibleActivityFallback: boolean;
    visibleActivityDelayMs: number;
  } | undefined;
  authorization?: {
    authority: AuthorizationAuthority;
    approvalTtlMs: number;
    maxPendingApprovals: number;
    ownerOnlyRemoteApproval: boolean;
    remoteModeCeiling?: "auto" | "full" | undefined;
    localConfirmation?: LocalConfirmationBroker | undefined;
  } | undefined;
  artifactEgress?: {
    policy: ArtifactEgressPolicy;
  } | undefined;
  systemAwareness?: SystemAwarenessReadProvider | undefined;
  systemMaintenance?: {
    controller: SystemMaintenanceController;
  } | undefined;
  deliveryOutbox?: DeliveryOutboxCoordinator | undefined;
  durableRuns?: DurableRunCoordinator | undefined;
  startupRecovery?: StartupRecoveryCoordinator | undefined;
}

interface ChatListCache {
  projectName: string;
  entries: AgentThreadSummary[];
  createdAtMs: number;
}

interface SelectedProjectContext {
  project: WorkspaceProject;
  threadId?: string | undefined;
}

interface QueuedAgentRun {
  message: IncomingMessage;
  resolved: ResolvedGatewayIdentity;
}

const CHAT_LIST_CACHE_TTL_MS = 5 * 60 * 1_000;
const MAX_QUEUED_AGENT_RUNS_PER_CONVERSATION = 3;

interface ActiveRun {
  threadId?: string;
  stopRequested: boolean;
  interruptSent: boolean;
  visibleActivityTimer?: ReturnType<typeof setTimeout> | undefined;
  visibleActivitySatisfied: boolean;
  waitingForApproval: boolean;
  latestToolName?: string | undefined;
  artifactEgressTail: Promise<void>;
  maintenanceTransactions: string[];
  maintenanceOwnerIntent: boolean;
  maintenanceAutoApproved: boolean;
  artifactBudget?: ArtifactEgressRunBudget | undefined;
}

export class GatewayService {
  readonly #activeRuns = new Map<string, ActiveRun>();
  readonly #artifactEgress: ArtifactEgressController;
  readonly #chatListCaches = new Map<string, ChatListCache>();
  readonly #controlModes = new Map<string, AgentControlMode>();
  readonly #loadedControlModes = new Set<string>();
  readonly #queuedAgentRuns = new Map<string, QueuedAgentRun[]>();
  readonly #startingAgentRuns = new Set<string>();
  readonly #cancelledStartingRuns = new Set<string>();
  readonly #inflightMessageHandlers = new Set<Promise<void>>();
  readonly #pairingLimiter = new PairingAttemptLimiter();
  readonly #approvalBroker: QqApprovalBroker | undefined;
  #started = false;
  #stopped = false;

  constructor(
    private readonly transport: ChatTransport,
    private readonly agent: AgentRuntime,
    private readonly store: GatewayStore,
    private readonly options: GatewayOptions,
  ) {
    this.#artifactEgress = new ArtifactEgressController(
      transport,
      store,
      options.artifactEgress?.policy,
      options.deliveryOutbox,
    );
    const authorization = options.authorization;
    const interactiveTransport = supportsInteractiveApproval(this.transport)
      ? this.transport
      : undefined;
    this.#approvalBroker = authorization
      ? new QqApprovalBroker({
          ttlMs: authorization.approvalTtlMs,
          maxPending: authorization.maxPendingApprovals,
          ownerOnly: authorization.ownerOnlyRemoteApproval,
          authority: authorization.authority,
          localConfirmation: authorization.localConfirmation,
          send: (conversationId, text) => this.#send(conversationId, text),
          ...(interactiveTransport ? {
            sendInteractive: (prompt) =>
              interactiveTransport.sendInteractiveApprovalPrompt(prompt),
          } : {}),
          autoApproveChatConfirmation: async (scope) => {
            if (scope.role !== "owner") return { approved: false, reason: "owner-required" };
            if (this.#controlMode(scope.conversationId) !== "full") {
              return { approved: false, reason: "full-mode-required" };
            }
            if (this.#remoteModeCeiling() !== "full") {
              return { approved: false, reason: "machine-ceiling-required" };
            }
            return { approved: true, reason: "trusted-owner-full" };
          },
          ...(options.systemMaintenance ? {
            autoApproveSystemMaintenance: async (scope) => {
              const active = this.#activeRuns.get(scope.conversationId);
              if (scope.role !== "owner") return { approved: false, reason: "owner-required" };
              if (!active?.maintenanceOwnerIntent) return { approved: false, reason: "explicit-owner-intent-required" };
              const allowed = await options.systemMaintenance!.controller.automaticApprovalAllowed("owner-auto");
              if (!allowed.allowed) return { approved: false, reason: allowed.reason };
              active.maintenanceAutoApproved = true;
              return { approved: true, reason: "owner-auto" };
            },
          } : {}),
          audit: (event) => this.store.appendAudit(event),
        })
      : undefined;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    if (this.#stopped) throw new Error("Gateway service cannot be restarted after stop");

    try {
      if (this.options.workspace) {
        await this.options.workspace.initialize();
        if (!supportsWorkspaceStateStore(this.store)) {
          throw new Error(
            "Configured workspace requires a WorkspaceStateStore-capable gateway store",
          );
        }
      }
      this.options.startupRecovery?.recover();
      await this.agent.start();
      await this.transport.start((message) => this.#trackMessage(message));
      await this.options.deliveryOutbox?.start();
      this.#started = true;
      for (const conversationId of this.options.durableRuns?.recover() ?? []) {
        this.#scheduleNextQueuedAgentRun(conversationId);
      }
    } catch (error) {
      await Promise.allSettled([
        this.options.deliveryOutbox?.stop(),
        this.transport.stop(),
        this.agent.stop(),
        this.store.close(),
      ]);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#approvalBroker?.cancelAll();
    await this.agent.stop().catch(() => undefined);
    const handlersDrained = await waitForInflightHandlers(this.#inflightMessageHandlers, 30_000);
    await this.options.deliveryOutbox?.stop();
    await this.transport.stop().catch(() => undefined);
    this.#activeRuns.clear();
    this.#artifactEgress.clear();
    this.#chatListCaches.clear();
    this.#controlModes.clear();
    this.#loadedControlModes.clear();
    this.#queuedAgentRuns.clear();
    this.#startingAgentRuns.clear();
    this.#cancelledStartingRuns.clear();
    if (handlersDrained) await this.store.close();
  }

  async #trackMessage(message: IncomingMessage): Promise<void> {
    if (this.#stopped) return;
    const operation = this.#handle(message);
    this.#inflightMessageHandlers.add(operation);
    try {
      await operation;
    } finally {
      this.#inflightMessageHandlers.delete(operation);
    }
  }

  async #handle(message: IncomingMessage): Promise<void> {
    if (!message.text.trim() && !(message.attachments?.length)) return;

    const command = parseGatewayCommand(message.text);
    const durableAgentMessage = !command && Boolean(this.options.durableRuns);
    if (!durableAgentMessage
      && !await this.store.acceptMessage(message.identity, message.id, message.receivedAt)) return;

    if (message.text.length > 32_000) {
      if (durableAgentMessage
        && !await this.store.acceptMessage(message.identity, message.id, message.receivedAt)) return;
      await this.store.appendAudit({
        eventType: "input.rejected_too_large",
        payload: {
          transport: message.identity.transport,
          characterCount: message.text.length,
        },
      });
      await this.#send(
        message.identity.conversationId,
        "消息过长，已拒绝执行。",
      );
      return;
    }

    let resolved = await this.store.resolveIdentity(message.identity);

    if (!resolved && message.identity.transport === "mock" && this.options.trustMockOwner) {
      resolved = await this.store.claimOwner(message.identity);
      await this.store.appendAudit({
        userId: resolved.userId,
        conversationId: resolved.conversationId,
        eventType: "identity.trusted_local_owner",
        payload: { transport: "mock" },
      });
    }

    if (!resolved) {
      if (durableAgentMessage
        && !await this.store.acceptMessage(message.identity, message.id, message.receivedAt)) return;
      if (command?.type === "pair") {
        await this.#handlePairing(message, command);
      } else {
        await this.store.appendAudit({
          eventType: "authorization.denied",
          payload: {
            transport: message.identity.transport,
            command: command?.type ?? "message",
          },
        });
        await this.#send(
          message.identity.conversationId,
          "当前聊天身份尚未绑定。请使用 /pair <配对码> 完成所有者绑定。",
        );
      }
      return;
    }

    await this.#loadPersistedControlMode(resolved);

    if (resolved.role === "owner" && this.options.systemMaintenance) {
      await this.options.systemMaintenance.controller
        .recordOwnerDeliveryTarget(message.identity.conversationId)
        .catch(() => undefined);
    }

    if (command) {
      await this.#handleCommand(message, resolved, command);
      return;
    }

    await this.#runAgent(message, resolved);
  }

  async #handlePairing(
    message: IncomingMessage,
    command: Extract<GatewayCommand, { type: "pair" }>,
  ): Promise<void> {
    const attemptKey = [
      message.identity.transport,
      message.identity.botId,
      message.identity.externalUserId,
    ].join("\u0000");

    if (!this.#pairingLimiter.canAttempt(attemptKey)) {
      await this.store.appendAudit({
        eventType: "identity.pairing_rate_limited",
        payload: { transport: message.identity.transport },
      });
      await this.#send(
        message.identity.conversationId,
        "配对尝试过于频繁，请稍后再试。",
      );
      return;
    }

    if (!this.options.ownerPairingCode) {
      await this.#send(
        message.identity.conversationId,
        "所有者配对尚未在服务器上启用。",
      );
      return;
    }

    if (await this.store.hasOwner(message.identity.transport, message.identity.botId)) {
      await this.#send(
        message.identity.conversationId,
        "该机器人已完成所有者绑定。",
      );
      return;
    }

    if (!pairingCodeMatches(command.code, this.options.ownerPairingCode)) {
      this.#pairingLimiter.recordFailure(attemptKey);
      await this.store.appendAudit({
        eventType: "identity.pairing_failed",
        payload: { transport: message.identity.transport },
      });
      await this.#send(
        message.identity.conversationId,
        command.code
          ? "配对失败。"
          : "用法：/pair <配对码>",
      );
      return;
    }

    try {
      const resolved = await this.store.claimOwner(message.identity);
      this.#pairingLimiter.recordSuccess(attemptKey);
      await this.store.appendAudit({
        userId: resolved.userId,
        conversationId: resolved.conversationId,
        eventType: "identity.owner_paired",
        payload: { transport: message.identity.transport },
      });
      await this.#send(
        message.identity.conversationId,
        "所有者绑定成功。现在可以发送消息，或使用 /status 查看状态。",
      );
    } catch {
      await this.store.appendAudit({
        eventType: "identity.pairing_conflict",
        payload: { transport: message.identity.transport },
      });
      await this.#send(
        message.identity.conversationId,
        "该机器人已完成所有者绑定。",
      );
    }
  }

  async #handleCommand(
    message: IncomingMessage,
    resolved: ResolvedGatewayIdentity,
    command: GatewayCommand,
  ): Promise<void> {
    switch (command.type) {
      case "pair":
        await this.#send(
          message.identity.conversationId,
          "当前身份已经完成绑定。",
        );
        return;

      case "status": {
        const projectContext = await this.#resolveSelectedProjectContext(
          resolved.conversationId,
        );
        const threadId = projectContext?.threadId
          ?? (!this.options.workspace
            ? await this.store.getActiveThread(resolved.conversationId)
            : undefined);
        const active = this.#conversationBusy(resolved.conversationId);
        await this.store.appendAudit({
          userId: resolved.userId,
          conversationId: resolved.conversationId,
          eventType: "command.status",
          payload: { debug: command.debug },
        });
        const runtimeCwd = projectContext?.project.path ?? this.options.cwd;
        const runtimeLines = this.options.runtimeStatusLines
          ? await this.options.runtimeStatusLines(runtimeCwd).catch(() => ["cost_guard=error"])
          : [];
        const controlMode = this.#controlMode(resolved.conversationId);
        const executionPolicy = executionPolicyForMode(controlMode);
        await this.#send(
          message.identity.conversationId,
          formatGatewayStatus({
            transport: this.transport.name,
            agent: this.agent.name,
            role: resolved.role,
            threadActive: Boolean(threadId),
            runActive: active,
            controlMode,
            remoteModeCeiling: this.#remoteModeCeiling(),
            sandboxMode: executionPolicy.sandboxMode,
            approvalPolicy: executionPolicy.approvalPolicy,
            approvalsReviewer: executionPolicy.approvalsReviewer,
            approvalRoute: executionPolicy.approvalRoute,
            workspaceEnabled: Boolean(this.options.workspace),
            ...(projectContext ? { selectedProject: projectContext.project.name } : {}),
            pendingApprovals: this.#approvalBroker?.pendingCount(resolved.conversationId) ?? 0,
            queuedRuns: this.#queuedRunCount(resolved.conversationId),
            runtimeLines,
          }, command.debug),
        );
        return;
      }

      case "help":
        await this.store.appendAudit({
          userId: resolved.userId,
          conversationId: resolved.conversationId,
          eventType: "command.help",
        });
        await this.#send(message.identity.conversationId, gatewayHelpText());
        return;

      case "skills": {
        const projectContext = await this.#resolveSelectedProjectContext(
          resolved.conversationId,
        );
        const cwd = projectContext?.project.path ?? this.options.cwd;
        if (!supportsAgentSkills(this.agent)) {
          await this.store.appendAudit({
            userId: resolved.userId,
            conversationId: resolved.conversationId,
            eventType: "command.skills_unavailable",
          });
          await this.#send(
            message.identity.conversationId,
            "当前 Agent Runtime 不支持 Codex Skill 发现。",
          );
          return;
        }
        try {
          const skills = await this.agent.listSkills({
            cwd,
            forceReload: true,
          });
          await this.store.appendAudit({
            userId: resolved.userId,
            conversationId: resolved.conversationId,
            eventType: "command.skills",
            payload: {
              count: skills.length,
              enabledCount: skills.filter((skill) => skill.enabled).length,
            },
          });
          await this.#send(
            message.identity.conversationId,
            formatAgentSkills(skills),
          );
        } catch (error) {
          await this.store.appendAudit({
            userId: resolved.userId,
            conversationId: resolved.conversationId,
            eventType: "command.skills_failed",
            payload: { errorType: error instanceof Error ? error.name : "Error" },
          });
          await this.#send(
            message.identity.conversationId,
            "Codex Skill 列表读取失败，请检查服务日志。",
          );
        }
        return;
      }

      case "apps": {
        const projectContext = await this.#resolveSelectedProjectContext(
          resolved.conversationId,
        );
        const cwd = projectContext?.project.path ?? this.options.cwd;
        if (!supportsAgentExtensionDiscovery(this.agent)) {
          await this.store.appendAudit({
            userId: resolved.userId,
            conversationId: resolved.conversationId,
            eventType: "command.apps_unavailable",
          });
          await this.#send(
            message.identity.conversationId,
            "当前 Agent Runtime 不支持 Codex App 发现。",
          );
          return;
        }
        try {
          const [apps, availableApps] = await Promise.all([
            this.agent.listInstalledApps({
              cwd,
              ...(projectContext?.threadId ? { threadId: projectContext.threadId } : {}),
              forceRefresh: false,
            }),
            this.agent.listAvailableApps({
              cwd,
              ...(projectContext?.threadId ? { threadId: projectContext.threadId } : {}),
              forceRefresh: false,
            }),
          ]);
          await this.store.appendAudit({
            userId: resolved.userId,
            conversationId: resolved.conversationId,
            eventType: "command.apps",
            payload: {
              count: apps.filter((app) => app.source === "installed-runtime").length,
              fallbackDirectoryCount: apps.filter(
                (app) => app.source === "directory-fallback",
              ).length,
              callableCount: apps.filter(
                (app) => app.source === "installed-runtime" && app.callable === true,
              ).length,
              callableUnknownCount: apps.filter(
                (app) => app.source === "installed-runtime" && app.callable === undefined,
              ).length,
              directoryCount: availableApps.length,
              accessibleDirectoryCount: availableApps.filter(
                (app) => app.accessible === true,
              ).length,
            },
          });
          await this.#send(
            message.identity.conversationId,
            formatAgentApps(apps, availableApps),
          );
        } catch (error) {
          await this.store.appendAudit({
            userId: resolved.userId,
            conversationId: resolved.conversationId,
            eventType: "command.apps_failed",
            payload: { errorType: error instanceof Error ? error.name : "Error" },
          });
          await this.#send(
            message.identity.conversationId,
            "Codex App 状态读取失败；当前 Codex App Server 版本可能不支持该接口，请检查服务日志。",
          );
        }
        return;
      }

      case "system": {
        const provider = this.options.systemAwareness;
        if (!provider) {
          await this.store.appendAudit({
            userId: resolved.userId,
            conversationId: resolved.conversationId,
            eventType: "command.system_unavailable",
          });
          await this.#send(
            message.identity.conversationId,
            "FLORAL System Awareness 只读接口当前不可用。",
          );
          return;
        }
        const projectContext = await this.#resolveSelectedProjectContext(
          resolved.conversationId,
        );
        const cwd = projectContext?.project.path ?? this.options.cwd;
        const threadId = projectContext?.threadId
          ?? (!this.options.workspace
            ? await this.store.getActiveThread(resolved.conversationId)
            : undefined);
        try {
          const controlMode = this.#controlMode(resolved.conversationId);
          const executionPolicy = executionPolicyForMode(controlMode);
          const model = await provider.read({
            cwd,
            ...(threadId ? { threadId } : {}),
            execution: {
              gateway: {
                controlMode,
                sandboxMode: executionPolicy.sandboxMode,
                approvalPolicy: executionPolicy.approvalPolicy,
                approvalsReviewer: executionPolicy.approvalsReviewer,
                approvalRoute: executionPolicy.approvalRoute,
              },
            },
          });
          const text = command.componentId
            ? formatSystemComponentStatus(model, command.componentId)
            : formatSystemSummary(model);
          await this.store.appendAudit({
            userId: resolved.userId,
            conversationId: resolved.conversationId,
            eventType: "command.system",
            payload: {
              componentId: command.componentId ?? null,
              componentCount: model.definitions.length,
              observerFailureCount: model.snapshot.observers.filter(
                (observer) => observer.status === "failed",
              ).length,
            },
          });
          await this.#send(message.identity.conversationId, text);
        } catch (error) {
          await this.store.appendAudit({
            userId: resolved.userId,
            conversationId: resolved.conversationId,
            eventType: "command.system_failed",
            payload: {
              componentId: command.componentId ?? null,
              errorType: error instanceof Error ? error.name : "Error",
            },
          });
          await this.#send(
            message.identity.conversationId,
            command.componentId
              ? `系统组件不存在或状态读取失败：${command.componentId}`
              : "FLORAL System Awareness 状态读取失败，请检查服务日志。",
          );
        }
        return;
      }

      case "diagnose": {
        const provider = this.options.systemAwareness;
        if (!provider) {
          await this.store.appendAudit({
            userId: resolved.userId,
            conversationId: resolved.conversationId,
            eventType: "command.diagnose_unavailable",
          });
          await this.#send(
            message.identity.conversationId,
            "FLORAL Self-Diagnostics 只读接口当前不可用。",
          );
          return;
        }
        const projectContext = await this.#resolveSelectedProjectContext(
          resolved.conversationId,
        );
        const cwd = projectContext?.project.path ?? this.options.cwd;
        const threadId = projectContext?.threadId
          ?? (!this.options.workspace
            ? await this.store.getActiveThread(resolved.conversationId)
            : undefined);
        try {
          const controlMode = this.#controlMode(resolved.conversationId);
          const executionPolicy = executionPolicyForMode(controlMode);
          const model = await provider.read({
            cwd,
            ...(threadId ? { threadId } : {}),
            execution: {
              gateway: {
                controlMode,
                sandboxMode: executionPolicy.sandboxMode,
                approvalPolicy: executionPolicy.approvalPolicy,
                approvalsReviewer: executionPolicy.approvalsReviewer,
                approvalRoute: executionPolicy.approvalRoute,
              },
            },
          });
          const text = command.debug
            ? formatSystemDiagnostics(model, command.componentId)
            : formatSystemDiagnosticsSummary(model, command.componentId);
          await this.store.appendAudit({
            userId: resolved.userId,
            conversationId: resolved.conversationId,
            eventType: "command.diagnose",
            payload: {
              componentId: command.componentId ?? null,
              debug: command.debug,
              observerFailureCount: model.snapshot.observers.filter(
                (observer) => observer.status === "failed",
              ).length,
            },
          });
          await this.#send(message.identity.conversationId, text);
        } catch (error) {
          await this.store.appendAudit({
            userId: resolved.userId,
            conversationId: resolved.conversationId,
            eventType: "command.diagnose_failed",
            payload: {
              componentId: command.componentId ?? null,
              errorType: error instanceof Error ? error.name : "Error",
            },
          });
          await this.#send(
            message.identity.conversationId,
            command.componentId
              ? `系统组件不存在或诊断失败：${command.componentId}`
              : "FLORAL Self-Diagnostics 读取失败，请检查服务日志。",
          );
        }
        return;
      }

      case "maintenance": {
        const controller = this.options.systemMaintenance?.controller;
        if (!controller) {
          await this.#send(message.identity.conversationId, "FLORAL 受治理维护接口当前不可用。");
          return;
        }
        const requested = command.value ?? "status";
        if (requested === "status") {
          await this.#send(message.identity.conversationId, maintenancePolicyText(await controller.autonomyStatus()));
          return;
        }
        if (resolved.role !== "owner") {
          await this.store.appendAudit({
            userId: resolved.userId,
            conversationId: resolved.conversationId,
            eventType: "command.maintenance_denied",
            payload: { requested, reason: "owner-required" },
          });
          await this.#send(message.identity.conversationId, "只有已绑定 owner 可以修改维护自治模式。");
          return;
        }
        if (requested === "reset-breaker") {
          const policy = await controller.resetCircuitBreaker();
          await this.store.appendAudit({
            userId: resolved.userId,
            conversationId: resolved.conversationId,
            eventType: "command.maintenance_breaker_reset",
          });
          await this.#send(message.identity.conversationId, [
            "维护自治 Circuit Breaker 已由 owner 重置。",
            maintenancePolicyText(policy),
          ].join("\n"));
          return;
        }
        if (requested !== "manual" && requested !== "owner-auto" && requested !== "self-heal") {
          await this.#send(message.identity.conversationId, "用法：/maintenance [status|manual|owner-auto|self-heal|reset-breaker]");
          return;
        }
        const result = await controller.setAutonomyMode(requested as MaintenanceAutonomyMode);
        await this.store.appendAudit({
          userId: resolved.userId,
          conversationId: resolved.conversationId,
          eventType: result.status === "updated" ? "command.maintenance_mode_changed" : "command.maintenance_denied",
          payload: { requested, reason: result.reason ?? null, effectiveMode: result.policy.effectiveMode, ceiling: result.policy.ceiling },
        });
        if (result.status === "denied") {
          await this.#send(message.identity.conversationId, [
            `维护自治模式未修改：请求=${requested} 超过本机 ceiling=${result.policy.ceiling}。`,
            `请在 Mac 本地 .env 设置 FLORAL_MAINTENANCE_MODE_CEILING=${requested}（或更高）并重启服务；Agent/项目配置不能提高该 ceiling。`,
            maintenancePolicyText(result.policy),
          ].join("\n"));
          return;
        }
        await this.#send(message.identity.conversationId, [
          `维护自治模式已切换为 ${result.policy.effectiveMode}。`,
          result.policy.effectiveMode === "manual"
            ? "所有 system.restart 继续要求 Mac 本地逐次确认。"
            : result.policy.effectiveMode === "owner-auto"
              ? "只有 host 明确认定为 owner 直接重启指令的请求可免逐次本地确认；Agent 自主提出的维护仍不会因此自动获批。"
              : "除 owner-auto 行为外，Host Self-Heal supervisor 可根据固定的高置信度 repair rule 自动恢复；模型不能自行声明 self-heal trigger。",
          maintenancePolicyText(result.policy),
        ].join("\n"));
        return;
      }

      case "mcp": {
        const projectContext = await this.#resolveSelectedProjectContext(
          resolved.conversationId,
        );
        const cwd = projectContext?.project.path ?? this.options.cwd;
        if (!supportsAgentExtensionDiscovery(this.agent)) {
          await this.#send(
            message.identity.conversationId,
            "当前 Agent Runtime 不支持 Codex MCP 状态发现。",
          );
          return;
        }
        try {
          const servers = await this.agent.listMcpServers({
            cwd,
            ...(projectContext?.threadId ? { threadId: projectContext.threadId } : {}),
          });
          await this.store.appendAudit({
            userId: resolved.userId,
            conversationId: resolved.conversationId,
            eventType: "command.mcp",
            payload: {
              count: servers.length,
              readyCount: servers.filter((server) => server.status === "ready").length,
            },
          });
          await this.#send(
            message.identity.conversationId,
            formatAgentMcpServers(servers),
          );
        } catch (error) {
          await this.store.appendAudit({
            userId: resolved.userId,
            conversationId: resolved.conversationId,
            eventType: "command.mcp_failed",
            payload: { errorType: error instanceof Error ? error.name : "Error" },
          });
          await this.#send(
            message.identity.conversationId,
            "Codex MCP 状态读取失败，请检查 App Server 版本与服务日志。",
          );
        }
        return;
      }

      case "plugins": {
        const projectContext = await this.#resolveSelectedProjectContext(
          resolved.conversationId,
        );
        const cwd = projectContext?.project.path ?? this.options.cwd;
        if (!supportsAgentExtensionDiscovery(this.agent)) {
          await this.#send(
            message.identity.conversationId,
            "当前 Agent Runtime 不支持 Codex Extension 状态发现。",
          );
          return;
        }
        try {
          const features = await this.agent.listNativeExtensionFeatures({ cwd });
          await this.store.appendAudit({
            userId: resolved.userId,
            conversationId: resolved.conversationId,
            eventType: "command.plugins",
            payload: {
              featureCount: features.length,
              pluginFeatureObserved: features.some((feature) => feature.name === "plugins"),
            },
          });
          await this.#send(
            message.identity.conversationId,
            formatNativePluginStatus(features),
          );
        } catch (error) {
          await this.store.appendAudit({
            userId: resolved.userId,
            conversationId: resolved.conversationId,
            eventType: "command.plugins_failed",
            payload: { errorType: error instanceof Error ? error.name : "Error" },
          });
          await this.#send(
            message.identity.conversationId,
            "Codex Extension 功能状态读取失败；不会回退调用上游仍处于 under-development 的 Plugin catalog RPC。",
          );
        }
        return;
      }

      case "native-memory-status": {
        await this.store.appendAudit({
          userId: resolved.userId,
          conversationId: resolved.conversationId,
          eventType: "command.native_memory_status",
          payload: {},
        });
        const projectContext = await this.#resolveSelectedProjectContext(
          resolved.conversationId,
        );
        const runtimeCwd = projectContext?.project.path ?? this.options.cwd;
        const runtimeLines = this.options.runtimeStatusLines
          ? await this.options.runtimeStatusLines(runtimeCwd).catch(() => ["codex_memory=unknown"])
          : ["codex_memory=unknown"];
        await this.#send(
          message.identity.conversationId,
          formatNativeMemoryStatus(runtimeLines),
        );
        return;
      }

      case "native-memory-diagnose": {
        if (resolved.role !== "owner") {
          await this.store.appendAudit({
            userId: resolved.userId,
            conversationId: resolved.conversationId,
            eventType: "command.native_memory_diagnose_denied",
            payload: { reason: "owner-required" },
          });
          await this.#send(
            message.identity.conversationId,
            "只有 owner 可以查看 Codex Native Memory Phase 2 深度诊断。",
          );
          return;
        }
        await this.store.appendAudit({
          userId: resolved.userId,
          conversationId: resolved.conversationId,
          eventType: "command.native_memory_diagnose",
          payload: {},
        });
        const projectContext = await this.#resolveSelectedProjectContext(
          resolved.conversationId,
        );
        const runtimeCwd = projectContext?.project.path ?? this.options.cwd;
        const diagnosticLines = this.options.nativeMemoryDiagnosticLines
          ? await this.options.nativeMemoryDiagnosticLines(runtimeCwd).catch(() => [
              "codex_memory_lifecycle=unknown",
              "codex_memory_phase2_diagnosis=unavailable",
            ])
          : [
              "codex_memory_lifecycle=unknown",
              "codex_memory_phase2_diagnosis=unavailable",
            ];
        await this.#send(
          message.identity.conversationId,
          formatNativeMemoryDiagnostics(diagnosticLines),
        );
        return;
      }

      case "new": {
        await this.#startNewChat(
          message.identity.conversationId,
          resolved,
          "command.new",
        );
        return;
      }

      case "projects": {
        if (!this.options.workspace) {
          await this.#send(
            message.identity.conversationId,
            "Workspace Root 尚未在 Mac 本地配置。",
          );
          return;
        }
        const projects = await this.options.workspace.listProjects();
        const selected = await this.#resolveSelectedProjectContext(
          resolved.conversationId,
        );
        const lines = ["可用项目："];
        if (projects.length === 0) {
          lines.push("（Workspace Root 下暂无可用项目目录）");
        } else {
          projects.slice(0, 50).forEach((project, index) => {
            const marker = selected?.project.name === project.name ? " ← 当前" : "";
            lines.push(`${String(index + 1)}. ${project.name}${marker}`);
          });
        }
        lines.push("", "使用 /project <name> 切换；/project new <name> 创建项目（owner）；/project context 查看共享上下文。");
        await this.store.appendAudit({
          userId: resolved.userId,
          conversationId: resolved.conversationId,
          eventType: "command.projects",
          payload: { count: projects.length },
        });
        await this.#send(message.identity.conversationId, lines.join("\n"));
        return;
      }

      case "project-new": {
        if (!this.options.workspace) {
          await this.#send(
            message.identity.conversationId,
            "Workspace Root 尚未在 Mac 本地配置。",
          );
          return;
        }
        if (!command.name) {
          await this.#send(
            message.identity.conversationId,
            "用法：/project new <name>",
          );
          return;
        }
        if (resolved.role !== "owner") {
          await this.store.appendAudit({
            userId: resolved.userId,
            conversationId: resolved.conversationId,
            eventType: "command.project_create_denied",
            payload: { reason: "owner-required" },
          });
          await this.#send(
            message.identity.conversationId,
            "只有 owner 可以创建项目。",
          );
          return;
        }
        if (this.#conversationBusy(resolved.conversationId)) {
          await this.#send(
            message.identity.conversationId,
            "当前任务运行中，不能创建项目。请先使用 /stop。",
          );
          return;
        }
        try {
          const project = await this.options.workspace.createProject(command.name);
          const workspaceStore = this.#workspaceStore();
          await workspaceStore.setSelectedProject(
            resolved.conversationId,
            project.name,
          );
          await workspaceStore.clearProjectActiveThread(
            resolved.conversationId,
            project.name,
          );
          this.#chatListCaches.delete(resolved.conversationId);
          this.#artifactEgress.clearConversation(resolved.conversationId);
          await this.store.appendAudit({
            userId: resolved.userId,
            conversationId: resolved.conversationId,
            eventType: "command.project_created",
            payload: { projectName: project.name },
          });
          await this.#send(
            message.identity.conversationId,
            [
              `已创建并切换到项目：${project.name}。`,
              "已初始化 AGENTS.md 与 .floral 项目共享上下文。",
              "下一条普通消息会创建第一个 Codex 会话，并由 Codex 原生加载项目 AGENTS.md。",
            ].join("\n"),
          );
        } catch {
          await this.store.appendAudit({
            userId: resolved.userId,
            conversationId: resolved.conversationId,
            eventType: "command.project_create_failed",
            payload: {},
          });
          await this.#send(
            message.identity.conversationId,
            "项目创建失败。名称必须是 Workspace Root 下可创建的真实一级目录名，且不能已存在。",
          );
        }
        return;
      }

      case "project-context-status": {
        if (!this.options.workspace) {
          await this.#send(
            message.identity.conversationId,
            "Workspace Root 尚未在 Mac 本地配置。",
          );
          return;
        }
        const projectContext = await this.#requireProjectContext(
          message.identity.conversationId,
          resolved.conversationId,
        );
        if (!projectContext) return;
        try {
          const status = await inspectProjectContext(projectContext.project);
          await this.store.appendAudit({
            userId: resolved.userId,
            conversationId: resolved.conversationId,
            eventType: "command.project_context_status",
            payload: {
              projectName: projectContext.project.name,
              initialized: status.initialized,
              instructionLinked: status.instructionLinked,
            },
          });
          await this.#send(
            message.identity.conversationId,
            formatProjectContextStatus(projectContext.project.name, status),
          );
        } catch {
          await this.#send(
            message.identity.conversationId,
            "项目共享上下文状态检查失败；请检查项目内 AGENTS/.floral 是否为真实常规文件。",
          );
        }
        return;
      }

      case "project-context-init": {
        if (!this.options.workspace) {
          await this.#send(
            message.identity.conversationId,
            "Workspace Root 尚未在 Mac 本地配置。",
          );
          return;
        }
        if (resolved.role !== "owner") {
          await this.store.appendAudit({
            userId: resolved.userId,
            conversationId: resolved.conversationId,
            eventType: "command.project_context_init_denied",
            payload: { reason: "owner-required" },
          });
          await this.#send(
            message.identity.conversationId,
            "只有 owner 可以初始化项目共享上下文。",
          );
          return;
        }
        if (this.#conversationBusy(resolved.conversationId)) {
          await this.#send(
            message.identity.conversationId,
            "当前任务运行中，不能初始化项目共享上下文。请先使用 /stop。",
          );
          return;
        }
        const projectContext = await this.#requireProjectContext(
          message.identity.conversationId,
          resolved.conversationId,
        );
        if (!projectContext) return;
        try {
          const result = await bootstrapProjectContext(projectContext.project);
          await this.store.appendAudit({
            userId: resolved.userId,
            conversationId: resolved.conversationId,
            eventType: "command.project_context_initialized",
            payload: {
              projectName: projectContext.project.name,
              changed: result.changed,
              instructionAction: result.instructionAction,
              createdFileCount: result.createdFiles.length,
            },
          });
          const lines = [
            result.changed
              ? `项目 ${projectContext.project.name} 的共享上下文已初始化。`
              : `项目 ${projectContext.project.name} 的共享上下文已经就绪，无需修改。`,
            formatProjectContextStatus(projectContext.project.name, result.status),
          ];
          if (projectContext.threadId) {
            lines.push(
              "当前项目已有活动 Codex 会话。为确保新的 AGENTS.md 指令链重新加载，建议使用 /chat new 开始新会话。",
            );
          }
          await this.#send(
            message.identity.conversationId,
            lines.join("\n\n"),
          );
        } catch {
          await this.store.appendAudit({
            userId: resolved.userId,
            conversationId: resolved.conversationId,
            eventType: "command.project_context_init_failed",
            payload: { projectName: projectContext.project.name },
          });
          await this.#send(
            message.identity.conversationId,
            "项目共享上下文初始化失败。不会覆盖既有上下文文件；请检查 AGENTS/.floral 文件类型、标记完整性或 Codex 指令文件大小。",
          );
        }
        return;
      }

      case "project-memory-status": {
        if (!this.options.workspace) {
          await this.#send(
            message.identity.conversationId,
            "Workspace Root 尚未在 Mac 本地配置。",
          );
          return;
        }
        const projectContext = await this.#requireProjectContext(
          message.identity.conversationId,
          resolved.conversationId,
        );
        if (!projectContext) return;
        try {
          const status = await inspectProjectMemory(projectContext.project);
          await this.store.appendAudit({
            userId: resolved.userId,
            conversationId: resolved.conversationId,
            eventType: "command.project_memory_status",
            payload: { projectName: projectContext.project.name },
          });
          await this.#send(
            message.identity.conversationId,
            formatProjectMemoryStatus(projectContext.project.name, status),
          );
        } catch {
          await this.#send(
            message.identity.conversationId,
            "项目长期记忆尚不可用。请先使用 /project context init 初始化共享上下文。",
          );
        }
        return;
      }

      case "project-memory-record": {
        if (!this.options.workspace) {
          await this.#send(
            message.identity.conversationId,
            "Workspace Root 尚未在 Mac 本地配置。",
          );
          return;
        }
        if (!command.text) {
          await this.#send(
            message.identity.conversationId,
            "用法：/project remember <context|decision|issue> <内容>",
          );
          return;
        }
        if (resolved.role !== "owner") {
          await this.store.appendAudit({
            userId: resolved.userId,
            conversationId: resolved.conversationId,
            eventType: "command.project_memory_denied",
            payload: { reason: "owner-required", kind: command.kind },
          });
          await this.#send(
            message.identity.conversationId,
            "只有 owner 可以写入项目长期记忆。",
          );
          return;
        }
        if (this.#conversationBusy(resolved.conversationId)) {
          await this.#send(
            message.identity.conversationId,
            "当前任务运行中，不能写入项目长期记忆。请先使用 /stop。",
          );
          return;
        }
        const projectContext = await this.#requireProjectContext(
          message.identity.conversationId,
          resolved.conversationId,
        );
        if (!projectContext) return;
        try {
          const result = await recordProjectMemory(
            projectContext.project,
            command.kind,
            command.text,
          );
          await this.store.appendAudit({
            userId: resolved.userId,
            conversationId: resolved.conversationId,
            eventType: "command.project_memory_recorded",
            payload: {
              projectName: projectContext.project.name,
              kind: command.kind,
              changed: result.changed,
              duplicate: result.duplicate,
              fingerprint: result.fingerprint,
              characterCount: command.text.length,
            },
          });
          await this.#send(
            message.identity.conversationId,
            result.duplicate
              ? `该 ${humanizeProjectMemoryKind(command.kind)} 已存在，未重复写入。`
              : `已记录项目${humanizeProjectMemoryKind(command.kind)}。当前该类共有 ${String(result.entryCount)} 条 FLORAL 记录。`,
          );
        } catch {
          await this.store.appendAudit({
            userId: resolved.userId,
            conversationId: resolved.conversationId,
            eventType: "command.project_memory_failed",
            payload: {
              projectName: projectContext.project.name,
              kind: command.kind,
            },
          });
          await this.#send(
            message.identity.conversationId,
            "项目长期记忆写入失败。请确认共享上下文已初始化、目标文件未被替换，且单条内容与文件总量未超过限制。",
          );
        }
        return;
      }

      case "project": {
        if (!this.options.workspace) {
          await this.#send(
            message.identity.conversationId,
            "Workspace Root 尚未在 Mac 本地配置。",
          );
          return;
        }
        if (!command.name) {
          const selected = await this.#resolveSelectedProjectContext(
            resolved.conversationId,
          );
          await this.#send(
            message.identity.conversationId,
            selected
              ? `当前项目=${selected.project.name}`
              : "当前尚未选择项目。使用 /projects 查看项目。",
          );
          return;
        }
        if (this.#conversationBusy(resolved.conversationId)) {
          await this.#send(
            message.identity.conversationId,
            "当前任务运行中，不能切换项目。请先使用 /stop。",
          );
          return;
        }
        try {
          const project = await this.options.workspace.resolveExistingProject(
            command.name,
          );
          const workspaceStore = this.#workspaceStore();
          await workspaceStore.setSelectedProject(
            resolved.conversationId,
            project.name,
          );
          await this.#migrateLegacyThreadIfApplicable(
            resolved.conversationId,
            project,
          );
          this.#chatListCaches.delete(resolved.conversationId);
          this.#artifactEgress.clearConversation(resolved.conversationId);
          await this.store.appendAudit({
            userId: resolved.userId,
            conversationId: resolved.conversationId,
            eventType: "command.project_selected",
            payload: { projectName: project.name },
          });
          await this.#send(
            message.identity.conversationId,
            `已切换到项目：${project.name}`,
          );
        } catch {
          await this.#send(
            message.identity.conversationId,
            "未找到可选择的项目。项目必须是 Workspace Root 下的真实一级目录。",
          );
        }
        return;
      }
      case "chats": {
        const projectContext = await this.#requireProjectContext(
          message.identity.conversationId,
          resolved.conversationId,
        );
        if (!projectContext) return;
        const { entries, text } = await listGatewayChats({
          agent: this.agent, cwd: projectContext.project.path,
          projectName: projectContext.project.name,
          activeThreadId: projectContext.threadId,
        }).catch(() => ({ entries: [], text: "当前 Agent runtime 未开放 Codex thread/list。" }));
        this.#chatListCaches.set(resolved.conversationId, {
          projectName: projectContext.project.name, entries, createdAtMs: Date.now(),
        });
        await this.store.appendAudit({
          userId: resolved.userId,
          conversationId: resolved.conversationId,
          eventType: "command.chats",
          payload: { projectName: projectContext.project.name, count: entries.length },
        });
        await this.#send(message.identity.conversationId, text);
        return;
      }
      case "goal": {
        const projectContext = await this.#requireProjectContext(
          message.identity.conversationId, resolved.conversationId,
        );
        if (!projectContext) return;
        if (!projectContext.threadId) {
          await this.#send(message.identity.conversationId,
            "当前项目还没有 Codex 会话。请先发送一条普通消息建立会话，再使用 /goal。");
          return;
        }
        await handleGatewayGoalCommand({
          agent: this.agent, command,
          threadId: projectContext.threadId,
          projectName: projectContext.project.name,
          userId: resolved.userId, conversationId: resolved.conversationId,
          role: resolved.role,
          busy: this.#conversationBusy(resolved.conversationId),
          audit: async (event) => this.store.appendAudit(event),
          send: async (text) => this.#send(message.identity.conversationId, text),
        });
        return;
      }
      case "chat-archive": {
        const value = command.value?.trim();
        if (!value) {
          await this.#send(
            message.identity.conversationId,
            "用法：/chat archive <序号>。请先使用 /chats 获取序号。",
          );
          return;
        }
        if (resolved.role !== "owner") {
          await this.store.appendAudit({
            userId: resolved.userId,
            conversationId: resolved.conversationId,
            eventType: "command.chat_archive_denied",
            payload: { reason: "owner-required" },
          });
          await this.#send(
            message.identity.conversationId,
            "只有 owner 可以归档 Codex 会话。",
          );
          return;
        }
        if (this.#conversationBusy(resolved.conversationId)) {
          await this.#send(
            message.identity.conversationId,
            "当前任务运行中，不能归档会话。请先使用 /stop。",
          );
          return;
        }
        const index = Number(value);
        if (!Number.isSafeInteger(index) || index < 1) {
          await this.#send(
            message.identity.conversationId,
            "用法：/chat archive <序号>。请先使用 /chats 获取序号。",
          );
          return;
        }
        const projectContext = await this.#requireProjectContext(
          message.identity.conversationId,
          resolved.conversationId,
        );
        if (!projectContext) return;
        if (!supportsAgentThreadManagement(this.agent)) {
          await this.#send(
            message.identity.conversationId,
            "当前 Agent runtime 未开放 Codex thread/archive。",
          );
          return;
        }
        const cache = this.#chatListCaches.get(resolved.conversationId);
        if (
          !cache
          || cache.projectName !== projectContext.project.name
          || Date.now() - cache.createdAtMs > CHAT_LIST_CACHE_TTL_MS
        ) {
          this.#chatListCaches.delete(resolved.conversationId);
          await this.#send(
            message.identity.conversationId,
            "会话列表不存在或已过期。请先重新使用 /chats。",
          );
          return;
        }
        const selected = cache.entries[index - 1];
        if (!selected) {
          await this.#send(
            message.identity.conversationId,
            "该会话序号不存在。请重新使用 /chats。",
          );
          return;
        }
        try {
          await this.agent.archiveThread(selected.id);
          const wasActive = selected.id === projectContext.threadId;
          if (wasActive) {
            await this.#workspaceStore().clearProjectActiveThread(
              resolved.conversationId,
              projectContext.project.name,
            );
          }
          this.#chatListCaches.delete(resolved.conversationId);
          this.#artifactEgress.clearConversation(resolved.conversationId);
          await this.store.appendAudit({
            userId: resolved.userId,
            conversationId: resolved.conversationId,
            eventType: "command.chat_archived",
            payload: {
              projectName: projectContext.project.name,
              listIndex: index,
              wasActive,
            },
          });
          await this.#send(
            message.identity.conversationId,
            `已归档会话：${formatThreadPreview(selected.preview)}。请重新使用 /chats 刷新列表。`,
          );
        } catch {
          await this.store.appendAudit({
            userId: resolved.userId,
            conversationId: resolved.conversationId,
            eventType: "command.chat_archive_failed",
            payload: {
              projectName: projectContext.project.name,
              listIndex: index,
            },
          });
          await this.#send(
            message.identity.conversationId,
            "Codex 会话归档失败；当前活动会话状态未改变。",
          );
        }
        return;
      }

      case "chat": {
        const value = command.value?.trim();
        if (!value) {
          const projectContext = await this.#requireProjectContext(
            message.identity.conversationId,
            resolved.conversationId,
          );
          if (!projectContext) return;
          await this.#send(
            message.identity.conversationId,
            projectContext.threadId
              ? `当前项目=${projectContext.project.name}；当前会话已建立。使用 /chats 查看可切换会话。`
              : `当前项目=${projectContext.project.name}；当前尚无活动会话。`,
          );
          return;
        }
        if (value.toLowerCase() === "new") {
          await this.#startNewChat(
            message.identity.conversationId,
            resolved,
            "command.chat_new",
          );
          return;
        }
        if (this.#conversationBusy(resolved.conversationId)) {
          await this.#send(
            message.identity.conversationId,
            "当前任务运行中，不能切换会话。请先使用 /stop。",
          );
          return;
        }
        const index = Number(value);
        if (!Number.isSafeInteger(index) || index < 1) {
          await this.#send(
            message.identity.conversationId,
            "用法：/chat <序号> 或 /chat new。请先使用 /chats 获取序号。",
          );
          return;
        }
        const projectContext = await this.#requireProjectContext(
          message.identity.conversationId,
          resolved.conversationId,
        );
        if (!projectContext) return;
        const cache = this.#chatListCaches.get(resolved.conversationId);
        if (
          !cache
          || cache.projectName !== projectContext.project.name
          || Date.now() - cache.createdAtMs > CHAT_LIST_CACHE_TTL_MS
        ) {
          this.#chatListCaches.delete(resolved.conversationId);
          await this.#send(
            message.identity.conversationId,
            "会话列表不存在或已过期。请先重新使用 /chats。",
          );
          return;
        }
        const selected = cache.entries[index - 1];
        if (!selected) {
          await this.#send(
            message.identity.conversationId,
            "该会话序号不存在。请重新使用 /chats。",
          );
          return;
        }
        await this.#workspaceStore().setProjectActiveThread(
          resolved.conversationId,
          projectContext.project.name,
          selected.id,
        );
        this.#artifactEgress.clearConversation(resolved.conversationId);
        await this.store.appendAudit({
          userId: resolved.userId,
          conversationId: resolved.conversationId,
          eventType: "command.chat_selected",
          payload: {
            projectName: projectContext.project.name,
            listIndex: index,
          },
        });
        await this.#send(
          message.identity.conversationId,
          `已切换会话：${formatThreadPreview(selected.preview)}`,
        );
        return;
      }

      case "mode": {
        const requestedMode = command.value ?? "status";
        if (requestedMode === "status") {
          await this.#send(
            message.identity.conversationId,
            modeStatusText(
              this.#controlMode(resolved.conversationId),
              this.#remoteModeCeiling(),
            ),
          );
          return;
        }
        if (
          requestedMode !== "ask"
          && requestedMode !== "auto"
          && requestedMode !== "full"
        ) {
          await this.#send(
            message.identity.conversationId,
            "用法：/mode [status|ask|auto|full]",
          );
          return;
        }
        if (this.#conversationBusy(resolved.conversationId)) {
          await this.#send(
            message.identity.conversationId,
            "当前任务运行中，执行模式将在任务结束后才能切换。",
          );
          return;
        }
        if (
          (requestedMode === "auto" || requestedMode === "full")
          && resolved.role !== "owner"
        ) {
          await this.store.appendAudit({
            userId: resolved.userId,
            conversationId: resolved.conversationId,
            eventType: "command.mode_denied",
            payload: { requestedMode, reason: "owner-required" },
          });
          await this.#send(
            message.identity.conversationId,
            requestedMode === "auto"
              ? "当前身份无权启用自动审查模式。"
              : "当前身份无权提升执行模式。",
          );
          return;
        }
        if (
          requestedMode === "full"
          && (
            this.#remoteModeCeiling() !== "full"
            || !this.#approvalBroker
          )
        ) {
          await this.store.appendAudit({
            userId: resolved.userId,
            conversationId: resolved.conversationId,
            eventType: "command.mode_denied",
            payload: { requestedMode, reason: "machine-ceiling" },
          });
          await this.#send(
            message.identity.conversationId,
            "本机未预授权 full 模式。请在 Mac 本地将 FLORAL_REMOTE_MODE_CEILING=full 后重启服务。",
          );
          return;
        }

        if (requestedMode === "ask") {
          this.#controlModes.delete(resolved.conversationId);
        } else {
          this.#controlModes.set(resolved.conversationId, requestedMode);
        }
        if (supportsConversationControlState(this.store)) {
          await this.store.setConversationControlMode(
            resolved.conversationId,
            requestedMode,
          );
        }
        await this.store.appendAudit({
          userId: resolved.userId,
          conversationId: resolved.conversationId,
          eventType: "command.mode_changed",
          payload: { mode: requestedMode },
        });
        await this.#send(
          message.identity.conversationId,
          modeChangedText(requestedMode),
        );
        return;
      }

      case "approve":
      case "approve-session":
      case "deny": {
        if (!command.approvalId) {
          await this.#send(
            message.identity.conversationId,
            `用法：/${command.type} <审批编号>`,
          );
          return;
        }
        if (!this.#approvalBroker) {
          await this.#send(message.identity.conversationId, "远程审批功能未启用。");
          return;
        }
        const outcome = await this.#approvalBroker.resolve(
          {
            userId: resolved.userId,
            role: resolved.role,
            conversationId: resolved.conversationId,
          },
          command.approvalId,
          command.type === "approve"
            ? "approve"
            : command.type === "approve-session"
              ? "approve-session"
              : "deny",
        );
        await this.store.appendAudit({
          userId: resolved.userId,
          conversationId: resolved.conversationId,
          eventType: `command.${command.type}`,
          payload: { outcome },
        });
        await this.#send(
          message.identity.conversationId,
          approvalCommandReply(command.type, outcome),
        );
        return;
      }

      case "stop": {
        const active = this.#activeRuns.get(resolved.conversationId);
        const starting = this.#startingAgentRuns.has(resolved.conversationId);
        const queuedCount = this.#queuedRunCount(resolved.conversationId);
        if (!active && !starting && queuedCount === 0) {
          await this.#send(
            message.identity.conversationId,
            "当前没有正在运行或排队的任务。",
          );
          return;
        }

        this.#queuedAgentRuns.delete(resolved.conversationId);
        this.options.durableRuns?.cancelPending(resolved.conversationId);
        if (starting) this.#cancelledStartingRuns.add(resolved.conversationId);
        this.#approvalBroker?.cancelConversation(resolved.conversationId);

        if (active) {
          active.stopRequested = true;
          this.#cancelVisibleActivityFallback(active);
          this.#setConversationActivity(message.identity.conversationId, "idle");
          if (active.threadId && !active.interruptSent) {
            await this.#interruptRun(resolved, active);
          }
        }
        await this.store.appendAudit({
          userId: resolved.userId,
          conversationId: resolved.conversationId,
          eventType: "command.stop",
          payload: {
            interruptDispatched: active?.interruptSent ?? false,
            preflightCancelled: starting,
            queuedCancelled: queuedCount,
          },
        });
        await this.#send(
          message.identity.conversationId,
          [
            active
              ? active.interruptSent
                ? "已向当前任务发送停止请求。"
                : "停止请求已记录，任务线程建立后会立即中断。"
              : "已取消正在准备中的任务。",
            ...(queuedCount > 0 ? [`已同时取消 ${String(queuedCount)} 条排队消息。`] : []),
          ].join("\n"),
        );
        return;
      }
    }
  }

  async #runAgent(
    message: IncomingMessage,
    resolved: ResolvedGatewayIdentity,
    durableRun?: DurableAgentRunRecord,
  ): Promise<void> {
    const durableRuns = this.options.durableRuns;
    if (durableRuns && !durableRun) {
      const durableMessage = await this.#materializeDurableRunMessage(message, resolved);
      if (!durableMessage) return;
      const busy = this.#activeRuns.has(resolved.conversationId)
        || this.#startingAgentRuns.has(resolved.conversationId)
        || durableRuns.pendingCount(resolved.conversationId) > 0;
      const queuedCount = durableRuns.pendingCount(resolved.conversationId);
      if (busy && queuedCount >= MAX_QUEUED_AGENT_RUNS_PER_CONVERSATION) {
        if (!await this.store.acceptMessage(message.identity, message.id, message.receivedAt)) return;
        await this.#send(
          message.identity.conversationId,
          `上一任务仍在运行，待处理队列已满（${String(MAX_QUEUED_AGENT_RUNS_PER_CONVERSATION)} 条）。请等待、使用 /stop 清空，或稍后重发。`,
        );
        return;
      }
      const queued = durableRuns.enqueue(durableMessage, resolved);
      if (!await this.store.acceptMessage(message.identity, message.id, message.receivedAt)) {
        return;
      }
      if (["executing", "completed", "failed", "cancelled"].includes(queued.transaction.status)) {
        return;
      }
      if (busy) {
        const depth = durableRuns.pendingCount(resolved.conversationId);
        await this.store.appendAudit({
          userId: resolved.userId,
          conversationId: resolved.conversationId,
          eventType: "agent.run_queued",
          payload: { queueDepth: depth, durable: true, transactionId: queued.id },
        }).catch(() => undefined);
        await this.#send(
          message.identity.conversationId,
          `上一任务仍在运行；这条消息已持久化排队（${String(depth)}/${String(MAX_QUEUED_AGENT_RUNS_PER_CONVERSATION)}），服务重启后也会继续。使用 /stop 可停止当前任务并清空队列。`,
        );
        return;
      }
      const claimed = durableRuns.claim(queued.id);
      if (!claimed) {
        this.#scheduleNextQueuedAgentRun(resolved.conversationId);
        return;
      }
      await durableRuns.execute(
        claimed,
        () => this.#runAgent(claimed.message, claimed.resolved, claimed),
      );
      return;
    }

    if (
      !durableRun
      && (this.#activeRuns.has(resolved.conversationId)
      || this.#startingAgentRuns.has(resolved.conversationId)
      )
    ) {
      const queue = this.#queuedAgentRuns.get(resolved.conversationId) ?? [];
      if (queue.length >= MAX_QUEUED_AGENT_RUNS_PER_CONVERSATION) {
        await this.#send(
          message.identity.conversationId,
          `上一任务仍在运行，待处理队列已满（${String(MAX_QUEUED_AGENT_RUNS_PER_CONVERSATION)} 条）。请等待、使用 /stop 清空，或稍后重发。`,
        );
        return;
      }
      queue.push({ message, resolved });
      this.#queuedAgentRuns.set(resolved.conversationId, queue);
      await this.store.appendAudit({
        userId: resolved.userId,
        conversationId: resolved.conversationId,
        eventType: "agent.run_queued",
        payload: { queueDepth: queue.length },
      }).catch(() => undefined);
      await this.#send(
        message.identity.conversationId,
        `上一任务仍在运行；这条消息已排队（${String(queue.length)}/${String(MAX_QUEUED_AGENT_RUNS_PER_CONVERSATION)}），完成后会自动继续。使用 /stop 可停止当前任务并清空队列。`,
      );
      return;
    }

    // Reserve the conversation before the first asynchronous preflight read.
    // Without this reservation two near-simultaneous messages can both pass
    // the active-run check while project/thread/attachment setup is awaiting,
    // causing overlapping Codex turns for one conversation.
    this.#startingAgentRuns.add(resolved.conversationId);

    let projectContext: SelectedProjectContext | undefined;
    let persistedThreadId: string | undefined;
    try {
      projectContext = this.options.workspace
        ? await this.#requireProjectContext(
            message.identity.conversationId,
            resolved.conversationId,
          )
        : undefined;
      if (this.options.workspace && !projectContext) {
        this.#startingAgentRuns.delete(resolved.conversationId);
        this.#cancelledStartingRuns.delete(resolved.conversationId);
        this.#scheduleNextQueuedAgentRun(resolved.conversationId);
        return;
      }

      persistedThreadId = projectContext?.threadId
        ?? (!this.options.workspace
          ? await this.store.getActiveThread(resolved.conversationId)
          : undefined);
    } catch (error) {
      this.#startingAgentRuns.delete(resolved.conversationId);
      this.#cancelledStartingRuns.delete(resolved.conversationId);
      this.#scheduleNextQueuedAgentRun(resolved.conversationId);
      throw error;
    }
    await this.#artifactEgress.prepareProjectStaging(resolved, this.options.workspace, projectContext?.project);
    const runCwd = projectContext?.project.path ?? this.options.cwd;
    let agentMessage = message;
    if (message.attachments?.length) {
      try {
        if (message.attachments.some((attachment) => !attachment.localPath)) {
          if (!supportsInboundAttachmentMaterializer(this.transport)) {
            throw new Error("Inbound attachment materializer is unavailable");
          }
          agentMessage = await this.transport.materializeInboundAttachments(
            message,
            projectContext
              ? { projectNamespace: projectRuntimeNamespace(projectContext.project.path) }
              : undefined,
          );
        }
        await assertDurableAttachmentsAvailable(agentMessage);
      } catch (error) {
        await this.store.appendAudit({
          userId: resolved.userId,
          conversationId: resolved.conversationId,
          eventType: "input.attachment_materialization_failed",
          payload: {
            transport: message.identity.transport,
            attachmentCount: message.attachments.length,
            errorType: error instanceof Error ? error.name : "Error",
          },
        }).catch(() => undefined);
        this.#startingAgentRuns.delete(resolved.conversationId);
        this.#cancelledStartingRuns.delete(resolved.conversationId);
        this.#scheduleNextQueuedAgentRun(resolved.conversationId);
        await this.#send(message.identity.conversationId, "排队附件已丢失、变化或下载失败，请重新发送该图片或文件。");
        return;
      }
    }
    if (this.#cancelledStartingRuns.delete(resolved.conversationId)) {
      this.#startingAgentRuns.delete(resolved.conversationId);
      this.#setConversationActivity(message.identity.conversationId, "idle");
      this.#scheduleNextQueuedAgentRun(resolved.conversationId);
      return;
    }

    let agentInputText: string;
    try {
      agentInputText = renderIncomingMessageForAgent(agentMessage);
    } catch (error) {
      // Rendering is expected to be synchronous and side-effect free, but a
      // malformed attachment must not leave the preflight reservation wedged.
      this.#startingAgentRuns.delete(resolved.conversationId);
      this.#cancelledStartingRuns.delete(resolved.conversationId);
      this.#setConversationActivity(message.identity.conversationId, "idle");
      this.#scheduleNextQueuedAgentRun(resolved.conversationId);
      throw error;
    }

    const active: ActiveRun = {
      stopRequested: false,
      interruptSent: false,
      visibleActivitySatisfied: false,
      waitingForApproval: false,
      artifactEgressTail: Promise.resolve(),
      maintenanceTransactions: [],
      maintenanceOwnerIntent: resolved.role === "owner" && isExplicitOwnerServiceRestartRequest(message.text),
      maintenanceAutoApproved: false,
      ...(this.options.artifactEgress
        ? { artifactBudget: this.options.artifactEgress.policy.createRunBudget() }
        : {}),
    };
    this.#activeRuns.set(resolved.conversationId, active);
    this.#startingAgentRuns.delete(resolved.conversationId);

    const controlMode = this.#controlMode(resolved.conversationId);
    const executionPolicy = executionPolicyForMode(controlMode);
    await this.store.appendAudit({
      userId: resolved.userId,
      conversationId: resolved.conversationId,
      eventType: "agent.run_requested",
      payload: {
        characterCount: message.text.length,
        attachmentCount: agentMessage.attachments?.length ?? 0,
        attachmentBytes: (agentMessage.attachments ?? []).reduce(
          (sum, attachment) => sum + (attachment.byteLength ?? 0),
          0,
        ),
        controlMode,
        sandboxMode: executionPolicy.sandboxMode,
        approvalPolicy: executionPolicy.approvalPolicy,
        approvalsReviewer: executionPolicy.approvalsReviewer,
        approvalRoute: executionPolicy.approvalRoute,
        ...(projectContext ? { projectName: projectContext.project.name } : {}),
      },
    }).catch(() => undefined);
    this.#setConversationActivity(message.identity.conversationId, "typing");
    this.#scheduleVisibleActivityFallback(
      message.identity.conversationId,
      resolved,
      active,
    );

    try {
      const result = await this.agent.run(
        {
          ...(persistedThreadId ? { threadId: persistedThreadId } : {}),
          text: agentInputText,
          cwd: runCwd,
          approvalPolicy: executionPolicy.approvalPolicy,
          sandboxMode: executionPolicy.sandboxMode,
          approvalsReviewer: executionPolicy.approvalsReviewer,
          controlMode,
          approvalRoute: executionPolicy.approvalRoute,
          ...(this.options.model ? { model: this.options.model } : {}),
          ...(this.options.artifactEgress ? {
            artifactRegistrationHandler: async (request) =>
              await this.#queueArtifactOperation(active, () =>
                this.#artifactEgress.registerOutboundFile(resolved, runCwd, request)
              ),
            artifactDeliveryHandler: async (request) =>
              await this.#queueArtifactOperation(active, () =>
                this.#artifactEgress.deliverRegistered(
                  message.identity.conversationId,
                  resolved,
                  active.artifactBudget,
                  request.artifactId,
                  request.caption,
                )
              ),
          } : {}),
          ...(controlMode !== "auto" && this.#approvalBroker ? {
            approvalHandler: async (request) =>
              await this.#requestRemoteApproval(
                message.identity.conversationId,
                resolved,
                active,
                request,
              ),
          } : {}),
          ...(this.#approvalBroker ? {
            mcpToolApprovalHandler: async (request) =>
              await this.#requestRemoteApproval(
                message.identity.conversationId,
                resolved,
                active,
                request,
              ),
            skillManagementApprovalHandler: async (request) =>
              await this.#requestRemoteApproval(
                message.identity.conversationId,
                resolved,
                active,
                request,
              ),
            extensionManagementApprovalHandler: async (request) =>
              await this.#requestRemoteApproval(
                message.identity.conversationId,
                resolved,
                active,
                request,
              ),
            ...(this.options.systemMaintenance ? {
              systemMaintenanceApprovalHandler: async (request) =>
                await this.#requestRemoteApproval(
                  message.identity.conversationId,
                  resolved,
                  active,
                  request,
                ),
              systemMaintenanceHandler: async (request) => {
                if (active.maintenanceTransactions.length > 0) {
                  return { status: "denied" as const, reason: "one-maintenance-action-per-run" };
                }
                const prepared = await this.options.systemMaintenance!.controller.prepare(request, {
                  trigger: active.maintenanceAutoApproved ? "owner-auto" : "manual",
                });
                if (prepared.result.status === "queued" && prepared.transactionId) {
                  active.maintenanceTransactions.push(prepared.transactionId);
                  await this.store.appendAudit({
                    userId: resolved.userId,
                    conversationId: resolved.conversationId,
                    eventType: "system.maintenance_queued",
                    payload: {
                      transactionId: prepared.transactionId,
                      componentId: request.componentId,
                      actionId: request.actionId,
                    },
                  }).catch(() => undefined);
                }
                return prepared.result;
              },
            } : {}),
          } : {}),
        },
        (event) => this.#handleAgentEvent(
          message.identity.conversationId,
          resolved,
          active,
          event,
        ),
      );

      await active.artifactEgressTail.catch(() => undefined);
      if (projectContext) {
        await this.#workspaceStore().setProjectActiveThread(
          resolved.conversationId,
          projectContext.project.name,
          result.threadId,
        );
      } else {
        await this.store.setActiveThread(resolved.conversationId, result.threadId);
      }
      await this.store.appendAudit({
        userId: resolved.userId,
        conversationId: resolved.conversationId,
        eventType: "agent.run_completed",
        payload: { responseCharacterCount: result.finalText.length },
      }).catch(() => undefined);
      this.#cancelVisibleActivityFallback(active);
      this.#setConversationActivity(message.identity.conversationId, "idle");
      const replyDelivered = await this.#deliverWithAudit(
        message.identity.conversationId,
        result.finalText,
        resolved,
        "agent_reply",
        `agent-reply:${message.identity.transport}:${message.id}`,
      );
      if (active.maintenanceTransactions.length > 0 && this.options.systemMaintenance) {
        if (!replyDelivered) {
          for (const transactionId of active.maintenanceTransactions) {
            const cancelled = await this.options.systemMaintenance.controller
              .cancelQueued(transactionId, "final-reply-delivery-failed")
              .catch(() => false);
            if (cancelled) {
              await this.store.appendAudit({
                userId: resolved.userId,
                conversationId: resolved.conversationId,
                eventType: "system.maintenance_cancelled",
                payload: { transactionId, reason: "final-reply-delivery-failed" },
              }).catch(() => undefined);
            }
          }
        } else {
          for (const transactionId of active.maintenanceTransactions) {
            try {
              await this.options.systemMaintenance.controller.execute(transactionId);
              await this.store.appendAudit({
                userId: resolved.userId,
                conversationId: resolved.conversationId,
                eventType: "system.maintenance_handoff",
                payload: { transactionId },
              }).catch(() => undefined);
            } catch (error) {
              await this.store.appendAudit({
                userId: resolved.userId,
                conversationId: resolved.conversationId,
                eventType: "system.maintenance_handoff_failed",
                payload: {
                  transactionId,
                  errorType: error instanceof Error ? error.name : "Error",
                },
              }).catch(() => undefined);
              await this.#deliverWithAudit(
                message.identity.conversationId,
                `FLORAL 维护交接失败。transaction=${transactionId}。未执行通用 shell 回退；请在下一回合检查 floral.maintenance。`,
                resolved,
                "agent_failure",
              ).catch(() => undefined);
            }
          }
        }
      }
    } catch (error) {
      if (active.maintenanceTransactions.length > 0 && this.options.systemMaintenance) {
        for (const transactionId of active.maintenanceTransactions) {
          const cancelled = await this.options.systemMaintenance.controller
            .cancelQueued(transactionId)
            .catch(() => false);
          if (cancelled) {
            await this.store.appendAudit({
              userId: resolved.userId,
              conversationId: resolved.conversationId,
              eventType: "system.maintenance_cancelled",
              payload: { transactionId, reason: "run-ended-before-handoff" },
            }).catch(() => undefined);
          }
        }
      }
      this.#cancelVisibleActivityFallback(active);
      this.#setConversationActivity(message.identity.conversationId, "idle");
      process.stderr.write(`${formatSafeAgentFailure(error)}\n`);
      await this.store.appendAudit({
        userId: resolved.userId,
        conversationId: resolved.conversationId,
        eventType: "agent.run_failed",
        payload: {
          errorType: error instanceof Error ? error.name : "unknown",
          stopRequested: active.stopRequested,
        },
      }).catch(() => undefined);
      await this.#deliverWithAudit(
        message.identity.conversationId,
        active.stopRequested
          ? "当前任务已停止。"
          : agentFailureUserMessage(error),
        resolved,
        "agent_failure",
        `agent-failure:${message.identity.transport}:${message.id}`,
      );
    } finally {
      this.#cancelVisibleActivityFallback(active);
      this.#approvalBroker?.cancelConversation(resolved.conversationId);
      if (this.#activeRuns.get(resolved.conversationId) === active) {
        this.#activeRuns.delete(resolved.conversationId);
        this.#scheduleNextQueuedAgentRun(resolved.conversationId);
      }
    }
  }

  #scheduleNextQueuedAgentRun(conversationId: string): void {
    if (
      this.#stopped
      || this.#activeRuns.has(conversationId)
      || this.#startingAgentRuns.has(conversationId)
    ) return;
    const durableRuns = this.options.durableRuns;
    if (durableRuns) {
      const next = durableRuns.claimNext(conversationId);
      if (!next) return;
      // Reserve the event-loop gap between durable claim and turn startup.
      this.#startingAgentRuns.add(conversationId);
      setImmediate(() => {
        if (this.#stopped) return;
        void durableRuns.execute(
          next,
          () => this.#runAgent(next.message, next.resolved, next),
        ).catch(async (error) => {
          this.#startingAgentRuns.delete(conversationId);
          process.stderr.write(
            `agent.durable_run_failed=${safeLogToken(error instanceof Error ? error.name : "Error")}\n`,
          );
          await this.#deliverWithAudit(
            next.message.identity.conversationId,
            agentFailureUserMessage(error),
            next.resolved,
            "agent_failure",
            `agent-failure:${next.message.identity.transport}:${next.message.id}`,
          ).catch(() => undefined);
          this.#scheduleNextQueuedAgentRun(conversationId);
        });
      });
      return;
    }
    const queue = this.#queuedAgentRuns.get(conversationId);
    const next = queue?.shift();
    if (!next) {
      this.#queuedAgentRuns.delete(conversationId);
      return;
    }
    if (queue && queue.length > 0) this.#queuedAgentRuns.set(conversationId, queue);
    else this.#queuedAgentRuns.delete(conversationId);

    setImmediate(() => {
      if (this.#stopped) return;
      void this.#runAgent(next.message, next.resolved).catch(async (error) => {
        process.stderr.write(
          `agent.queued_run_failed=${safeLogToken(error instanceof Error ? error.name : "Error")}\n`,
        );
        await this.#deliverWithAudit(
          next.message.identity.conversationId,
          agentFailureUserMessage(error),
          next.resolved,
          "agent_failure",
        ).catch(() => undefined);
      });
    });
  }

  async #materializeDurableRunMessage(
    message: IncomingMessage,
    resolved: ResolvedGatewayIdentity,
  ): Promise<IncomingMessage | undefined> {
    const attachments = message.attachments ?? [];
    if (attachments.length === 0 || attachments.every((attachment) => attachment.localPath)) {
      return message;
    }
    if (!supportsInboundAttachmentMaterializer(this.transport)) {
      await this.store.appendAudit({
        userId: resolved.userId,
        conversationId: resolved.conversationId,
        eventType: "input.attachment_spool_unavailable",
        payload: { transport: message.identity.transport },
      }).catch(() => undefined);
      await this.#send(message.identity.conversationId, "附件无法写入持久化私有队列，请重新发送。");
      return undefined;
    }
    try {
      const project = this.options.workspace
        ? await this.#resolveSelectedProjectContext(resolved.conversationId)
        : undefined;
      return await this.transport.materializeInboundAttachments(
        message,
        project
          ? { projectNamespace: projectRuntimeNamespace(project.project.path) }
          : undefined,
      );
    } catch (error) {
      await this.store.appendAudit({
        userId: resolved.userId,
        conversationId: resolved.conversationId,
        eventType: "input.attachment_spool_failed",
        payload: {
          transport: message.identity.transport,
          attachmentCount: attachments.length,
          errorType: error instanceof Error ? error.name : "Error",
        },
      }).catch(() => undefined);
      await this.#send(message.identity.conversationId, "附件持久化失败，请重新发送该图片或文件。");
      return undefined;
    }
  }

  async #requestRemoteApproval(
    deliveryConversationId: string,
    resolved: ResolvedGatewayIdentity,
    active: ActiveRun,
    request: AgentApprovalRequest,
  ): Promise<AgentApprovalDecision> {
    const broker = this.#approvalBroker;
    if (!broker) return "deny";

    active.waitingForApproval = true;
    active.visibleActivitySatisfied = true;
    this.#cancelVisibleActivityFallback(active);
    this.#setConversationActivity(deliveryConversationId, "idle");
    try {
      return await broker.request(
        {
          userId: resolved.userId,
          role: resolved.role,
          conversationId: resolved.conversationId,
          deliveryConversationId,
        },
        request,
      );
    } finally {
      active.waitingForApproval = false;
      if (
        !active.stopRequested
        && this.#activeRuns.get(resolved.conversationId) === active
      ) {
        this.#setConversationActivity(deliveryConversationId, "typing");
      }
    }
  }

  #handleAgentEvent(
    deliveryConversationId: string,
    resolved: ResolvedGatewayIdentity,
    active: ActiveRun,
    event: AgentEvent,
  ): void {
    if (event.type === "run.started") {
      active.threadId = event.threadId;
      if (active.stopRequested && !active.interruptSent) {
        void this.#interruptRun(resolved, active).catch(() => undefined);
      }
      return;
    }

    if (event.type === "tool.started" || event.type === "tool.completed") {
      if (event.type === "tool.started") active.latestToolName = event.name;
      process.stderr.write(`agent.${event.type}=${safeLogToken(event.name)}\n`);
      void this.store.appendAudit({
        userId: resolved.userId,
        conversationId: resolved.conversationId,
        eventType: `agent.${event.type}`,
        payload: { tool: event.name },
      }).catch(() => undefined);
      return;
    }

    if (event.type === "artifact.registered") {
      void this.#queueArtifactOperation(active, async () => {
        await this.#artifactEgress.register(resolved, event.artifact);
      }).catch((error) => {
        process.stderr.write(
          `artifact.registration_failed=${safeLogToken(
            error instanceof Error ? error.name : "Error",
          )}\n`,
        );
      });
      return;
    }

    if (event.type === "artifact.available") {
      active.artifactEgressTail = active.artifactEgressTail
        .catch(() => undefined)
        .then(async () => {
          await this.#artifactEgress.deliver(
            deliveryConversationId,
            resolved,
            active.artifactBudget,
            event.artifact,
          );
        });
      return;
    }

    if (event.type === "approval.requested") {
      void this.store.appendAudit({
        userId: resolved.userId,
        conversationId: resolved.conversationId,
        eventType: "agent.approval_requested",
        payload: { capability: event.capability, kind: event.kind },
      }).catch(() => undefined);
    }
  }

  #scheduleVisibleActivityFallback(
    deliveryConversationId: string,
    resolved: ResolvedGatewayIdentity,
    active: ActiveRun,
  ): void {
    const ux = this.options.conversationUx;
    if (!ux?.visibleActivityFallback || active.visibleActivitySatisfied) return;
    this.#cancelVisibleActivityFallback(active);

    const timer = setTimeout(() => {
      active.visibleActivityTimer = undefined;
      if (
        active.stopRequested
        || active.waitingForApproval
        || active.visibleActivitySatisfied
        || this.#activeRuns.get(resolved.conversationId) !== active
      ) {
        return;
      }

      active.visibleActivitySatisfied = true;
      const progress = visibleActivityProgress(active.latestToolName);
      void (async () => {
        try {
          await this.#send(deliveryConversationId, progress.text);
          await this.store.appendAudit({
            userId: resolved.userId,
            conversationId: resolved.conversationId,
            eventType: "conversation.visible_activity_sent",
            payload: { category: progress.category },
          }).catch(() => undefined);
        } catch (error) {
          process.stderr.write(
            `conversation.visible_activity_error=${safeLogToken(
              error instanceof Error ? error.name : "Error",
            )}\n`,
          );
          await this.store.appendAudit({
            userId: resolved.userId,
            conversationId: resolved.conversationId,
            eventType: "conversation.visible_activity_failed",
            payload: {
              category: progress.category,
              errorType: error instanceof Error ? error.name : "unknown",
            },
          }).catch(() => undefined);
        }
      })();
    }, ux.visibleActivityDelayMs);
    timer.unref?.();
    active.visibleActivityTimer = timer;
  }

  #cancelVisibleActivityFallback(active: ActiveRun): void {
    if (!active.visibleActivityTimer) return;
    clearTimeout(active.visibleActivityTimer);
    active.visibleActivityTimer = undefined;
  }

  async #interruptRun(
    resolved: ResolvedGatewayIdentity,
    active: ActiveRun,
  ): Promise<void> {
    const threadId = active.threadId;
    if (!threadId || active.interruptSent) return;
    active.interruptSent = true;
    try {
      await this.agent.interrupt(threadId);
      await this.store.appendAudit({
        userId: resolved.userId,
        conversationId: resolved.conversationId,
        eventType: "agent.interrupt_sent",
      });
    } catch (error) {
      await this.store.appendAudit({
        userId: resolved.userId,
        conversationId: resolved.conversationId,
        eventType: "agent.interrupt_failed",
        payload: {
          errorType: error instanceof Error ? error.name : "unknown",
        },
      });
    }
  }

  async #queueArtifactOperation<T>(
    active: ActiveRun,
    operation: () => Promise<T>,
  ): Promise<T> {
    const current = active.artifactEgressTail
      .catch(() => undefined)
      .then(operation);
    active.artifactEgressTail = current.then(
      () => undefined,
      () => undefined,
    );
    return await current;
  }

  async #deliverWithAudit(
    conversationId: string,
    text: string,
    resolved: ResolvedGatewayIdentity,
    kind: "agent_reply" | "agent_failure",
    idempotencyKey?: string,
  ): Promise<boolean> {
    try {
      await this.#send(conversationId, text, idempotencyKey);
      return true;
    } catch (error) {
      await this.store.appendAudit({
        userId: resolved.userId,
        conversationId: resolved.conversationId,
        eventType: "transport.delivery_failed",
        payload: {
          transport: this.transport.name,
          kind,
          errorType: error instanceof Error ? error.name : "unknown",
        },
      }).catch(() => undefined);
      return false;
    }
  }

  #setConversationActivity(
    conversationId: string,
    state: ConversationActivityState,
  ): void {
    if (!supportsConversationActivity(this.transport)) return;
    void this.transport.setConversationActivity(conversationId, state).catch((error) => {
      process.stderr.write(
        `transport.activity_error=${safeLogToken(
          error instanceof Error ? error.name : "Error",
        )}\n`,
      );
    });
  }

  async #startNewChat(
    deliveryConversationId: string,
    resolved: ResolvedGatewayIdentity,
    eventType: "command.new" | "command.chat_new",
  ): Promise<void> {
    if (this.#conversationBusy(resolved.conversationId)) {
      await this.#send(
        deliveryConversationId,
        "当前仍有任务运行，请先使用 /stop。",
      );
      return;
    }

    let projectName: string | undefined;
    if (this.options.workspace) {
      const projectContext = await this.#requireProjectContext(
        deliveryConversationId,
        resolved.conversationId,
      );
      if (!projectContext) return;
      projectName = projectContext.project.name;
      await this.#workspaceStore().clearProjectActiveThread(
        resolved.conversationId,
        projectName,
      );
    } else {
      await this.store.clearActiveThread(resolved.conversationId);
    }

    this.#chatListCaches.delete(resolved.conversationId);
    this.#artifactEgress.clearConversation(resolved.conversationId);
    await this.store.appendAudit({
      userId: resolved.userId,
      conversationId: resolved.conversationId,
      eventType,
      payload: {
        ...(projectName ? { projectName } : {}),
      },
    });
    await this.#send(
      deliveryConversationId,
      projectName
        ? `项目 ${projectName} 已准备新会话。下一条普通消息会创建新的 Codex thread。`
        : "新会话已建立。下一条消息会从新的上下文开始。",
    );
  }

  async #requireProjectContext(
    deliveryConversationId: string,
    conversationId: string,
  ): Promise<SelectedProjectContext | undefined> {
    if (!this.options.workspace) {
      await this.#send(
        deliveryConversationId,
        "Workspace Root 尚未在 Mac 本地配置。",
      );
      return undefined;
    }
    const context = await this.#resolveSelectedProjectContext(conversationId);
    if (context) return context;
    await this.#send(
      deliveryConversationId,
      "当前尚未选择项目。使用 /projects 查看项目，再用 /project <name> 选择。",
    );
    return undefined;
  }

  async #resolveSelectedProjectContext(
    conversationId: string,
  ): Promise<SelectedProjectContext | undefined> {
    const workspace = this.options.workspace;
    if (!workspace) return undefined;
    const store = this.#workspaceStore();

    let selected = await store.getSelectedProject(conversationId);
    if (!selected) {
      selected = await workspace.projectNameForPath(this.options.cwd);
      if (selected) {
        await store.setSelectedProject(conversationId, selected);
      }
    }
    if (!selected) return undefined;

    let project: WorkspaceProject;
    try {
      project = await workspace.resolveExistingProject(selected);
    } catch {
      return undefined;
    }

    await this.#migrateLegacyThreadIfApplicable(conversationId, project);
    const threadId = await store.getProjectActiveThread(
      conversationId,
      project.name,
    );
    return {
      project,
      ...(threadId ? { threadId } : {}),
    };
  }

  async #migrateLegacyThreadIfApplicable(
    conversationId: string,
    project: WorkspaceProject,
  ): Promise<void> {
    const workspace = this.options.workspace;
    if (!workspace) return;
    const legacyProject = await workspace.projectNameForPath(this.options.cwd);
    if (legacyProject !== project.name) return;

    const store = this.#workspaceStore();
    if (await store.getProjectActiveThread(conversationId, project.name)) return;
    const legacyThread = await this.store.getActiveThread(conversationId);
    if (!legacyThread) return;
    await store.setProjectActiveThread(
      conversationId,
      project.name,
      legacyThread,
    );
    // Consume the legacy single-project pointer exactly once. Keeping it would
    // resurrect the old thread after `/chat new` clears the project bucket.
    await this.store.clearActiveThread(conversationId);
  }

  #workspaceStore() {
    if (!supportsWorkspaceStateStore(this.store)) {
      throw new Error("Gateway store does not support workspace state");
    }
    return this.store;
  }

  #conversationBusy(conversationId: string): boolean {
    return this.#activeRuns.has(conversationId)
      || this.#startingAgentRuns.has(conversationId)
      || this.#queuedRunCount(conversationId) > 0;
  }

  #queuedRunCount(conversationId: string): number {
    return this.options.durableRuns?.pendingCount(conversationId)
      ?? this.#queuedAgentRuns.get(conversationId)?.length
      ?? 0;
  }

  #controlMode(conversationId: string): AgentControlMode {
    return this.#controlModes.get(conversationId) ?? "ask";
  }

  async #loadPersistedControlMode(resolved: ResolvedGatewayIdentity): Promise<void> {
    if (this.#loadedControlModes.has(resolved.conversationId)) return;
    this.#loadedControlModes.add(resolved.conversationId);
    if (!supportsConversationControlState(this.store) || resolved.role !== "owner") return;
    const persisted = await this.store.getConversationControlMode(resolved.conversationId);
    if (persisted === "auto") {
      this.#controlModes.set(resolved.conversationId, "auto");
    } else if (persisted === "full" && this.#remoteModeCeiling() === "full") {
      this.#controlModes.set(resolved.conversationId, "full");
    }
  }

  #remoteModeCeiling(): "auto" | "full" {
    return this.options.authorization?.remoteModeCeiling ?? "auto";
  }

  async #send(
    conversationId: string,
    text: string,
    idempotencyKey?: string,
  ): Promise<void> {
    if (this.options.deliveryOutbox) {
      const delivery = await this.options.deliveryOutbox.sendText({
        conversationId,
        text,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      });
      if (delivery.transaction.status !== "completed") {
        throw new Error(`Durable delivery not acknowledged: ${delivery.transaction.status}`);
      }
      return;
    }
    await this.transport.send({ conversationId, text });
  }
}

async function waitForInflightHandlers(
  handlers: ReadonlySet<Promise<void>>,
  timeoutMs: number,
): Promise<boolean> {
  const active = [...handlers];
  if (active.length === 0) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
  await Promise.race([
    Promise.allSettled(active).then(() => undefined),
    timeout,
  ]);
  if (timer) clearTimeout(timer);
  if ([...handlers].length > 0) {
    process.stderr.write(`gateway.shutdown.inflight_timeout=${String(handlers.size)}\n`);
    return false;
  }
  return true;
}
