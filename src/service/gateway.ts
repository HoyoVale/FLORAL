import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  supportsAgentThreadManagement,
  supportsConversationActivity,
  supportsInteractiveApproval,
  supportsMediaTransport,
  supportsWorkspaceStateStore,
  type AgentRuntime,
  type AgentThreadSummary,
  type ChatTransport,
  type ConversationActivityState,
  type GatewayStore,
} from "../core/contracts.js";
import type {
  AgentArtifact,
  AgentArtifactDeliveryResult,
  AgentArtifactRegistrationResult,
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
import type {
  ArtifactEgressPolicy,
  ArtifactEgressRunBudget,
} from "../policy/artifact-egress-policy.js";
import {
  formatGatewayStatus,
  formatNativeMemoryDiagnostics,
  formatNativeMemoryStatus,
  gatewayHelpText,
} from "./gateway-status.js";
import type { ProjectWorkspaceRoot, WorkspaceProject } from "../workspace/project-workspace.js";
import {
  bootstrapProjectContext,
  inspectProjectContext,
  inspectProjectMemory,
  recordProjectMemory,
  type ProjectContextStatus,
  type ProjectMemoryStatus,
} from "../workspace/project-context.js";

export interface GatewayOptions {
  cwd: string;
  workspace?: ProjectWorkspaceRoot | undefined;
  model?: string;
  ownerPairingCode?: string;
  trustMockOwner?: boolean;
  runtimeStatusLines?: (() => Promise<string[]>) | undefined;
  nativeMemoryDiagnosticLines?: (() => Promise<string[]>) | undefined;
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
}

interface ArtifactCatalogEntry {
  artifact: AgentArtifact;
  registeredAtMs: number;
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

const CHAT_LIST_CACHE_TTL_MS = 5 * 60 * 1_000;

const ARTIFACT_CATALOG_TTL_MS = 30 * 60 * 1_000;
const ARTIFACT_CATALOG_MAX_ITEMS = 32;

type AgentControlMode = "ask" | "auto" | "full";

interface ActiveRun {
  threadId?: string;
  stopRequested: boolean;
  interruptSent: boolean;
  visibleActivityTimer?: ReturnType<typeof setTimeout> | undefined;
  visibleActivitySatisfied: boolean;
  waitingForApproval: boolean;
  latestToolName?: string | undefined;
  artifactEgressTail: Promise<void>;
  artifactBudget?: ArtifactEgressRunBudget | undefined;
}

export class GatewayService {
  readonly #activeRuns = new Map<string, ActiveRun>();
  readonly #artifactCatalogs = new Map<string, Map<string, ArtifactCatalogEntry>>();
  readonly #chatListCaches = new Map<string, ChatListCache>();
  readonly #controlModes = new Map<string, AgentControlMode>();
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
      await this.agent.start();
      await this.transport.start((message) => this.#handle(message));
      this.#started = true;
    } catch (error) {
      await Promise.allSettled([
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
    await Promise.allSettled([this.transport.stop(), this.agent.stop()]);
    this.#activeRuns.clear();
    this.#artifactCatalogs.clear();
    this.#chatListCaches.clear();
    this.#controlModes.clear();
    await this.store.close();
  }

  async #handle(message: IncomingMessage): Promise<void> {
    if (!message.text.trim()) return;

    const accepted = await this.store.acceptMessage(
      message.identity,
      message.id,
      message.receivedAt,
    );
    if (!accepted) return;

    if (message.text.length > 32_000) {
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
    const command = parseGatewayCommand(message.text);

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
        const active = this.#activeRuns.has(resolved.conversationId);
        await this.store.appendAudit({
          userId: resolved.userId,
          conversationId: resolved.conversationId,
          eventType: "command.status",
          payload: { debug: command.debug },
        });
        const runtimeLines = this.options.runtimeStatusLines
          ? await this.options.runtimeStatusLines().catch(() => ["cost_guard=error"])
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

      case "native-memory-status": {
        await this.store.appendAudit({
          userId: resolved.userId,
          conversationId: resolved.conversationId,
          eventType: "command.native_memory_status",
          payload: {},
        });
        const runtimeLines = this.options.runtimeStatusLines
          ? await this.options.runtimeStatusLines().catch(() => ["codex_memory=unknown"])
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
        const diagnosticLines = this.options.nativeMemoryDiagnosticLines
          ? await this.options.nativeMemoryDiagnosticLines().catch(() => [
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
        if (this.#activeRuns.has(resolved.conversationId)) {
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
          this.#artifactCatalogs.delete(resolved.conversationId);
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
        if (this.#activeRuns.has(resolved.conversationId)) {
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
        if (this.#activeRuns.has(resolved.conversationId)) {
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
        if (this.#activeRuns.has(resolved.conversationId)) {
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
          this.#artifactCatalogs.delete(resolved.conversationId);
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
        if (!supportsAgentThreadManagement(this.agent)) {
          await this.#send(
            message.identity.conversationId,
            "当前 Agent runtime 未开放 Codex thread/list。",
          );
          return;
        }
        const entries = await this.agent.listThreads({
          cwd: projectContext.project.path,
          limit: 20,
        });
        this.#chatListCaches.set(resolved.conversationId, {
          projectName: projectContext.project.name,
          entries,
          createdAtMs: Date.now(),
        });
        const lines = [`项目 ${projectContext.project.name} 的会话：`];
        if (entries.length === 0) {
          lines.push("（暂无 Codex 会话；下一条普通消息会创建第一个会话）");
        } else {
          entries.forEach((entry, index) => {
            const marker = entry.id === projectContext.threadId ? " ← 当前" : "";
            lines.push(`${String(index + 1)}. ${formatThreadPreview(entry.preview)}${marker}`);
          });
        }
        lines.push("", "使用 /chat <序号> 切换；/chat new 新建；/chat archive <序号> 归档（owner）。");
        await this.store.appendAudit({
          userId: resolved.userId,
          conversationId: resolved.conversationId,
          eventType: "command.chats",
          payload: {
            projectName: projectContext.project.name,
            count: entries.length,
          },
        });
        await this.#send(message.identity.conversationId, lines.join("\n"));
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
        if (this.#activeRuns.has(resolved.conversationId)) {
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
          this.#artifactCatalogs.delete(resolved.conversationId);
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
        if (this.#activeRuns.has(resolved.conversationId)) {
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
        this.#artifactCatalogs.delete(resolved.conversationId);
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
        if (this.#activeRuns.has(resolved.conversationId)) {
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
        if (!active) {
          await this.#send(
            message.identity.conversationId,
            "当前没有正在运行的任务。",
          );
          return;
        }

        active.stopRequested = true;
        this.#cancelVisibleActivityFallback(active);
        this.#setConversationActivity(message.identity.conversationId, "idle");
        this.#approvalBroker?.cancelConversation(resolved.conversationId);
        if (active.threadId && !active.interruptSent) {
          await this.#interruptRun(resolved, active);
        }
        await this.store.appendAudit({
          userId: resolved.userId,
          conversationId: resolved.conversationId,
          eventType: "command.stop",
          payload: { interruptDispatched: active.interruptSent },
        });
        await this.#send(
          message.identity.conversationId,
          active.interruptSent
            ? "已向当前任务发送停止请求。"
            : "停止请求已记录，任务线程建立后会立即中断。",
        );
        return;
      }
    }
  }

  async #runAgent(
    message: IncomingMessage,
    resolved: ResolvedGatewayIdentity,
  ): Promise<void> {
    if (this.#activeRuns.has(resolved.conversationId)) {
      await this.#send(
        message.identity.conversationId,
        "正在处理上一条消息。使用 /status 查看状态，或使用 /stop 停止。",
      );
      return;
    }

    const projectContext = this.options.workspace
      ? await this.#requireProjectContext(
          message.identity.conversationId,
          resolved.conversationId,
        )
      : undefined;
    if (this.options.workspace && !projectContext) return;

    const runCwd = projectContext?.project.path ?? this.options.cwd;
    const persistedThreadId = projectContext?.threadId
      ?? (!this.options.workspace
        ? await this.store.getActiveThread(resolved.conversationId)
        : undefined);

    const active: ActiveRun = {
      stopRequested: false,
      interruptSent: false,
      visibleActivitySatisfied: false,
      waitingForApproval: false,
      artifactEgressTail: Promise.resolve(),
      ...(this.options.artifactEgress
        ? { artifactBudget: this.options.artifactEgress.policy.createRunBudget() }
        : {}),
    };
    this.#activeRuns.set(resolved.conversationId, active);

    const controlMode = this.#controlMode(resolved.conversationId);
    const executionPolicy = executionPolicyForMode(controlMode);
    await this.store.appendAudit({
      userId: resolved.userId,
      conversationId: resolved.conversationId,
      eventType: "agent.run_requested",
      payload: {
        characterCount: message.text.length,
        controlMode,
        sandboxMode: executionPolicy.sandboxMode,
        approvalPolicy: executionPolicy.approvalPolicy,
        approvalsReviewer: executionPolicy.approvalsReviewer,
        approvalRoute: executionPolicy.approvalRoute,
        ...(projectContext ? { projectName: projectContext.project.name } : {}),
      },
    });
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
          text: message.text,
          cwd: runCwd,
          approvalPolicy: executionPolicy.approvalPolicy,
          sandboxMode: executionPolicy.sandboxMode,
          approvalsReviewer: executionPolicy.approvalsReviewer,
          ...(this.options.model ? { model: this.options.model } : {}),
          ...(this.options.artifactEgress ? {
            artifactRegistrationHandler: async (request) =>
              await this.#queueArtifactOperation(active, () =>
                this.#registerOutboundFile(resolved, runCwd, request)
              ),
            artifactDeliveryHandler: async (request) =>
              await this.#queueArtifactOperation(active, () =>
                this.#deliverRegisteredArtifact(
                  message.identity.conversationId,
                  resolved,
                  active,
                  request.artifactId,
                  request.caption,
                )
              ),
          } : {}),
          ...(controlMode !== "auto" && this.#approvalBroker ? {
            approvalHandler: async (request) => {
              if (
                controlMode === "full"
                && isCodexNativeFullAutoApproval(request)
              ) {
                await this.store.appendAudit({
                  userId: resolved.userId,
                  conversationId: resolved.conversationId,
                  eventType: "authorization.full_auto_granted",
                  payload: {
                    kind: request.kind,
                    capability: request.capability,
                  },
                }).catch(() => undefined);
                return "approve";
              }

              active.waitingForApproval = true;
              active.visibleActivitySatisfied = true;
              this.#cancelVisibleActivityFallback(active);
              this.#setConversationActivity(
                message.identity.conversationId,
                "idle",
              );
              const decision = await this.#approvalBroker!.request(
                {
                  userId: resolved.userId,
                  role: resolved.role,
                  conversationId: resolved.conversationId,
                  deliveryConversationId: message.identity.conversationId,
                },
                request,
              );
              active.waitingForApproval = false;
              if (
                !active.stopRequested
                && this.#activeRuns.get(resolved.conversationId) === active
              ) {
                this.#setConversationActivity(
                  message.identity.conversationId,
                  "typing",
                );
              }
              return decision;
            },
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
      });
      this.#cancelVisibleActivityFallback(active);
      this.#setConversationActivity(message.identity.conversationId, "idle");
      await this.#deliverWithAudit(
        message.identity.conversationId,
        result.finalText,
        resolved,
        "agent_reply",
      );
    } catch (error) {
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
      });
      await this.#deliverWithAudit(
        message.identity.conversationId,
        active.stopRequested
          ? "当前任务已停止。"
          : "任务执行失败，请在 Mac 本地查看服务日志。",
        resolved,
        "agent_failure",
      );
    } finally {
      this.#cancelVisibleActivityFallback(active);
      this.#approvalBroker?.cancelConversation(resolved.conversationId);
      if (this.#activeRuns.get(resolved.conversationId) === active) {
        this.#activeRuns.delete(resolved.conversationId);
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
        await this.#registerArtifact(resolved, event.artifact);
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
          await this.#deliverArtifact(
            deliveryConversationId,
            resolved,
            active,
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

  async #registerOutboundFile(
    resolved: ResolvedGatewayIdentity,
    runCwd: string,
    request: {
      localPath: string;
      fileName?: string | undefined;
      caption?: string | undefined;
    },
  ): Promise<AgentArtifactRegistrationResult> {
    if (!await isWithinRunOutboundRoot(runCwd, request.localPath)) {
      await this.store.appendAudit({
        userId: resolved.userId,
        conversationId: resolved.conversationId,
        eventType: "artifact.registration_denied",
        payload: {
          kind: "file",
          reason: "outside-run-outbound-root",
        },
      }).catch(() => undefined);
      return { status: "denied", reason: "outside-run-outbound-root" };
    }
    return await this.#registerArtifact(resolved, {
      id: `artifact-file-${randomUUID()}`,
      kind: "file",
      localPath: request.localPath,
      source: {
        type: "floral",
        capability: "files.read",
      },
      ...(request.fileName ? { fileName: request.fileName } : {}),
      ...(request.caption ? { caption: request.caption } : {}),
    });
  }

  async #registerArtifact(
    resolved: ResolvedGatewayIdentity,
    artifact: AgentArtifact,
  ): Promise<AgentArtifactRegistrationResult> {
    const egress = this.options.artifactEgress;
    if (!egress) {
      return { status: "denied", reason: "policy-disabled" };
    }

    const candidate = await egress.policy.validateCandidate(artifact);
    if (candidate.status === "deny") {
      await this.store.appendAudit({
        userId: resolved.userId,
        conversationId: resolved.conversationId,
        eventType: "artifact.registration_denied",
        payload: {
          artifactId: artifact.id,
          kind: artifact.kind,
          reason: candidate.reason,
        },
      }).catch(() => undefined);
      return { status: "denied", reason: candidate.reason };
    }

    const catalog = this.#artifactCatalog(resolved.conversationId);
    this.#pruneArtifactCatalog(catalog);
    const existing = catalog.get(candidate.artifact.id);
    if (existing) {
      const same = existing.artifact.localPath === candidate.artifact.localPath
        && existing.artifact.kind === candidate.artifact.kind;
      return same
        ? { status: "registered", artifactId: candidate.artifact.id }
        : { status: "denied", reason: "duplicate-artifact-id" };
    }

    while (catalog.size >= ARTIFACT_CATALOG_MAX_ITEMS) {
      const oldest = catalog.keys().next().value as string | undefined;
      if (!oldest) break;
      catalog.delete(oldest);
    }
    catalog.set(candidate.artifact.id, {
      artifact: candidate.artifact,
      registeredAtMs: Date.now(),
    });
    await this.store.appendAudit({
      userId: resolved.userId,
      conversationId: resolved.conversationId,
      eventType: "artifact.registered",
      payload: {
        artifactId: candidate.artifact.id,
        kind: candidate.artifact.kind,
        sourceCapability: candidate.sourceCapability,
        bytes: candidate.byteLength,
      },
    }).catch(() => undefined);
    process.stderr.write(
      `artifact.registered=${safeLogToken(candidate.artifact.id)} kind=${safeLogToken(candidate.artifact.kind)}\n`,
    );
    return { status: "registered", artifactId: candidate.artifact.id };
  }

  async #deliverRegisteredArtifact(
    deliveryConversationId: string,
    resolved: ResolvedGatewayIdentity,
    active: ActiveRun,
    artifactId: string,
    caption?: string,
  ): Promise<AgentArtifactDeliveryResult> {
    const catalog = this.#artifactCatalog(resolved.conversationId);
    this.#pruneArtifactCatalog(catalog);
    const entry = catalog.get(artifactId);
    if (!entry) {
      await this.store.appendAudit({
        userId: resolved.userId,
        conversationId: resolved.conversationId,
        eventType: "artifact.delivery_denied",
        payload: { artifactId, reason: "artifact-not-found" },
      }).catch(() => undefined);
      return {
        status: "denied",
        artifactId,
        reason: "artifact-not-found",
      };
    }

    const artifact = caption
      ? { ...entry.artifact, caption }
      : entry.artifact;
    return await this.#deliverArtifact(
      deliveryConversationId,
      resolved,
      active,
      artifact,
    );
  }

  #artifactCatalog(
    conversationId: string,
  ): Map<string, ArtifactCatalogEntry> {
    const existing = this.#artifactCatalogs.get(conversationId);
    if (existing) return existing;
    const created = new Map<string, ArtifactCatalogEntry>();
    this.#artifactCatalogs.set(conversationId, created);
    return created;
  }

  #pruneArtifactCatalog(
    catalog: Map<string, ArtifactCatalogEntry>,
    now = Date.now(),
  ): void {
    for (const [artifactId, entry] of catalog) {
      if (now - entry.registeredAtMs > ARTIFACT_CATALOG_TTL_MS) {
        catalog.delete(artifactId);
      }
    }
  }

  async #deliverArtifact(
    deliveryConversationId: string,
    resolved: ResolvedGatewayIdentity,
    active: ActiveRun,
    artifact: AgentArtifact,
  ): Promise<AgentArtifactDeliveryResult> {
    const egress = this.options.artifactEgress;
    const budget = active.artifactBudget;
    if (!egress || !budget) {
      await this.#auditArtifactEgress(
        resolved,
        artifact,
        "denied",
        "policy-disabled",
      );
      return {
        status: "denied",
        artifactId: artifact.id,
        reason: "policy-disabled",
      };
    }
    const mediaTransport = supportsMediaTransport(this.transport)
      ? this.transport
      : undefined;
    if (!mediaTransport) {
      await this.#auditArtifactEgress(
        resolved,
        artifact,
        "denied",
        "transport-media-unsupported",
      );
      return {
        status: "denied",
        artifactId: artifact.id,
        reason: "transport-media-unsupported",
      };
    }

    const decision = await egress.policy.authorizeAndReserve({
      role: resolved.role,
      artifact,
      budget,
    });
    if (decision.status === "deny") {
      await this.#auditArtifactEgress(
        resolved,
        artifact,
        "denied",
        decision.reason,
      );
      return {
        status: "denied",
        artifactId: artifact.id,
        reason: decision.reason,
      };
    }

    try {
      await mediaTransport.sendMedia({
        conversationId: deliveryConversationId,
        ...decision.media,
      });
      await this.store.appendAudit({
        userId: resolved.userId,
        conversationId: resolved.conversationId,
        eventType: "artifact.egress_sent",
        payload: {
          artifactId: artifact.id,
          kind: artifact.kind,
          sourceCapability: decision.sourceCapability,
          bytes: decision.byteLength,
        },
      });
      return {
        status: "sent",
        artifactId: artifact.id,
        kind: artifact.kind,
        byteLength: decision.byteLength,
      };
    } catch (error) {
      await this.store.appendAudit({
        userId: resolved.userId,
        conversationId: resolved.conversationId,
        eventType: "artifact.egress_failed",
        payload: {
          artifactId: artifact.id,
          kind: artifact.kind,
          errorType: error instanceof Error ? error.name : "unknown",
        },
      }).catch(() => undefined);
      process.stderr.write(
        `artifact.egress_failed=${safeLogToken(
          error instanceof Error ? error.name : "Error",
        )}\n`,
      );
      return {
        status: "failed",
        artifactId: artifact.id,
        reason: "transport-delivery-failed",
      };
    }
  }

  async #auditArtifactEgress(
    resolved: ResolvedGatewayIdentity,
    artifact: Extract<AgentEvent, { type: "artifact.available" }>["artifact"],
    outcome: "denied",
    reason: string,
  ): Promise<void> {
    await this.store.appendAudit({
      userId: resolved.userId,
      conversationId: resolved.conversationId,
      eventType: "artifact.egress_denied",
      payload: {
        artifactId: artifact.id,
        kind: artifact.kind,
        outcome,
        reason,
      },
    }).catch(() => undefined);
    process.stderr.write(
      `artifact.egress_denied=${safeLogToken(reason)} kind=${safeLogToken(artifact.kind)}\n`,
    );
  }

  async #deliverWithAudit(
    conversationId: string,
    text: string,
    resolved: ResolvedGatewayIdentity,
    kind: "agent_reply" | "agent_failure",
  ): Promise<void> {
    try {
      await this.#send(conversationId, text);
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
      });
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
    if (this.#activeRuns.has(resolved.conversationId)) {
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
    this.#artifactCatalogs.delete(resolved.conversationId);
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

  #controlMode(conversationId: string): AgentControlMode {
    return this.#controlModes.get(conversationId) ?? "ask";
  }

  #remoteModeCeiling(): "auto" | "full" {
    return this.options.authorization?.remoteModeCeiling ?? "auto";
  }

  async #send(conversationId: string, text: string): Promise<void> {
    await this.transport.send({ conversationId, text });
  }
}

function formatProjectContextStatus(
  projectName: string,
  status: ProjectContextStatus,
): string {
  return [
    `项目共享上下文：${projectName}`,
    `state=${status.initialized ? "ready" : "not-ready"}`,
    `instruction=${status.activeInstructionFile ?? "missing"}`,
    `instruction_link=${status.instructionLinked ? "linked" : "missing"}`,
    `context=${status.contextPresent ? "present" : "missing"}`,
    `decisions=${status.decisionsPresent ? "present" : "missing"}`,
    `known_issues=${status.knownIssuesPresent ? "present" : "missing"}`,
    status.initialized
      ? "Codex 新会话会通过原生 AGENTS 指令发现获得共享上下文入口。"
      : "使用 /project context init 初始化（owner）。",
  ].join("\n");
}

function formatProjectMemoryStatus(
  projectName: string,
  status: ProjectMemoryStatus,
): string {
  return [
    `项目长期记忆：${projectName}`,
    `context_entries=${String(status.contextEntries)}`,
    `decision_entries=${String(status.decisionEntries)}`,
    `issue_entries=${String(status.issueEntries)}`,
    `context_bytes=${String(status.contextBytes)}`,
    `decision_bytes=${String(status.decisionBytes)}`,
    `issue_bytes=${String(status.issueBytes)}`,
    "写入策略=explicit-owner-only；不会从普通聊天自动提取。",
    "使用 /project remember <context|decision|issue> <内容> 显式记录。",
  ].join("\n");
}

function humanizeProjectMemoryKind(
  kind: "context" | "decision" | "issue",
): string {
  if (kind === "decision") return "决策";
  if (kind === "issue") return "已知问题";
  return "上下文";
}

interface AgentExecutionPolicy {
  sandboxMode: "workspace-write" | "danger-full-access";
  approvalPolicy: "untrusted";
  approvalsReviewer: "user" | "auto_review";
  approvalRoute: "owner" | "auto-review" | "full-auto-codex-native";
}

function executionPolicyForMode(mode: AgentControlMode): AgentExecutionPolicy {
  if (mode === "full") {
    return {
      sandboxMode: "danger-full-access",
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      approvalRoute: "full-auto-codex-native",
    };
  }
  if (mode === "auto") {
    return {
      sandboxMode: "workspace-write",
      approvalPolicy: "untrusted",
      approvalsReviewer: "auto_review",
      approvalRoute: "auto-review",
    };
  }
  return {
    sandboxMode: "workspace-write",
    approvalPolicy: "untrusted",
    approvalsReviewer: "user",
    approvalRoute: "owner",
  };
}

function isCodexNativeFullAutoApproval(
  request: import("../core/types.js").AgentApprovalRequest,
): boolean {
  return request.source === "codex"
    && (
      request.kind === "command-execution"
      || request.kind === "file-change"
      || request.kind === "permission-request"
    );
}

function modeStatusText(
  mode: AgentControlMode,
  ceiling: "auto" | "full",
): string {
  const policy = executionPolicyForMode(mode);
  if (mode === "full") {
    return [
      "执行模式=full",
      "Codex sandbox=danger-full-access。",
      "Codex 原生命令/文件/结构化权限请求自动批准；GUI shell bypass 仍硬拒绝，MCP/Artifact 策略保持独立。",
      `本机权限上限=${ceiling}`,
    ].join("\n");
  }
  if (mode === "auto") {
    return [
      "执行模式=auto",
      "Codex approvalsReviewer=auto_review。",
      "FLORAL 不会为本模式补做远程人工审批；未被 Codex 自动审查接管的请求将拒绝。",
      `sandbox=${policy.sandboxMode}；本机权限上限=${ceiling}`,
    ].join("\n");
  }
  return [
    "执行模式=ask",
    "Codex 原生审批请求会转交当前已绑定 owner 处理。",
    "可使用 /approve、/approve-session 或 /deny。",
    `sandbox=${policy.sandboxMode}；本机权限上限=${ceiling}`,
  ].join("\n");
}

function modeChangedText(mode: AgentControlMode): string {
  if (mode === "full") {
    return "已切换到 full：Codex 使用 danger-full-access，Codex-native 执行审批自动通过；GUI/MCP/Artifact 的 FLORAL 专属边界不随之取消。服务重启后恢复 ask。";
  }
  return mode === "auto"
    ? "已切换到 auto：Codex 使用 auto_review；当前 sandbox 保持 workspace-write。服务重启后会恢复 ask。"
    : "已切换到 ask：Codex 原生审批请求会转交当前 owner。";
}

async function isWithinRunOutboundRoot(
  runCwd: string,
  localPath: string,
): Promise<boolean> {
  if (!isAbsolute(localPath)) return false;
  try {
    const outboundRoot = await realpath(resolve(runCwd, "artifacts", "outbound"));
    const candidate = await realpath(localPath);
    const rel = relative(outboundRoot, candidate);
    return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
  } catch {
    return false;
  }
}

function formatThreadPreview(value: string): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) return "未命名会话";
  const characters = Array.from(normalized);
  return characters.length > 88
    ? `${characters.slice(0, 88).join("")}…`
    : normalized;
}

function visibleActivityProgress(toolName: string | undefined): {
  text: string;
  category: "search" | "reading" | "tool" | "thinking";
} {
  const normalized = toolName?.toLowerCase() ?? "";
  if (/(?:search|searx|web)/u.test(normalized)) {
    return { text: "正在搜索相关信息…", category: "search" };
  }
  if (/(?:read|file|list|grep|find)/u.test(normalized)) {
    return { text: "正在读取相关资料…", category: "reading" };
  }
  if (normalized) {
    return { text: "正在处理工具结果…", category: "tool" };
  }
  return { text: "正在处理，请稍候…", category: "thinking" };
}

function approvalCommandReply(
  _command: "approve" | "approve-session" | "deny",
  outcome: "approved" | "approved-session" | "denied" | "not-found" | "not-authorized",
): string {
  if (outcome === "approved") return "一次性授权已批准。";
  if (outcome === "approved-session") return "当前 Codex 会话授权已批准。";
  if (outcome === "denied") return "Codex 授权已拒绝。";
  return "未找到可由当前会话处理的有效审批，可能已处理、过期或不属于当前会话。";
}

function formatSafeAgentFailure(error: unknown): string {
  const record = typeof error === "object" && error !== null
    ? error as Record<string, unknown>
    : undefined;
  const type = error instanceof Error ? error.name : "unknown";
  const kind = typeof record?.kind === "string" ? record.kind : "unknown";
  const method = typeof record?.method === "string" ? record.method : "unknown";
  const code = typeof record?.code === "number" ? String(record.code) : "none";
  const reason = error instanceof Error ? safeLogMessage(error.message) : '"unknown"';
  return `agent.run_failed.type=${safeLogToken(type)} kind=${safeLogToken(kind)} method=${safeLogToken(method)} code=${safeLogToken(code)} reason=${reason}`;
}

function safeLogMessage(value: string): string {
  const redacted = value
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/((?:api[_-]?key|token|secret|password)\s*[=:]\s*)[^\s,;]+/giu, "$1<redacted>")
    .replace(/([?&](?:api[_-]?key|token|secret|password)=)[^&\s]+/giu, "$1<redacted>")
    .replace(/Bearer\s+[^\s,;]+/giu, "Bearer <redacted>")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 320);
  return JSON.stringify(redacted || "unknown");
}

function safeLogToken(value: string): string {
  return value.replace(/[^A-Za-z0-9_.\/-]/g, "_").slice(0, 96) || "unknown";
}
