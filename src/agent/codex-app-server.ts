import { resolve } from "node:path";
import type { AgentRuntime } from "../core/contracts.js";
import type {
  AgentApprovalHandler,
  AgentApprovalRequest,
  AgentArtifact,
  AgentArtifactDeliveryHandler,
  AgentArtifactRegistrationHandler,
  AgentEvent,
  AgentRunRequest,
  AgentRunResult,
} from "../core/types.js";
import {
  CodexRuntimeError,
  classifyCodexFailure,
  codexProtocolError,
  codexRequestTimeout,
} from "./codex-errors.js";
import { capabilityForMcpTool } from "../policy/authorization-authority.js";
import {
  CodexRpcClient,
  type CodexExitEvent,
  type CodexServerRequest,
} from "./codex-rpc-client.js";

interface ThreadResponse {
  thread: { id: string };
}

interface TurnResponse {
  turn: { id: string; status?: string };
}

interface TurnCompletedParams {
  threadId?: string;
  turn: {
    id: string;
    status: string;
    error?: unknown;
    items?: unknown[];
  };
}

interface ItemLifecycleParams {
  threadId?: string;
  turnId?: string;
  item?: {
    id?: string;
    type?: string;
    text?: string;
    phase?: string;
    server?: string;
    tool?: string;
    status?: string;
    arguments?: unknown;
    result?: unknown;
    namespace?: string;
    error?: unknown;
    command?: string;
    cwd?: string;
    changes?: Array<{ path?: string; kind?: string; diff?: string }>;
  };
}

interface AgentDeltaParams {
  threadId?: string;
  turnId?: string;
  itemId?: string;
  delta?: string;
  text?: string;
}

interface ErrorNotificationParams {
  threadId?: string;
  turnId?: string;
  error?: unknown;
}

export interface CodexAppServerOptions {
  command: string;
  args: string[];
  requestTimeoutMs: number;
  defaultModel: string | undefined;
  approvalPolicy?: "never" | "on-request" | "untrusted" | undefined;
  sandboxMode?: "read-only" | "workspace-write" | undefined;
  approvalsReviewer?: "user" | undefined;
  developerInstructions?: string | undefined;
  processCwd?: string | undefined;
  processEnv?: NodeJS.ProcessEnv | undefined;
}

interface TurnTerminalState {
  params: TurnCompletedParams;
  errorNotification: unknown;
}

interface InFlightMcpToolCall {
  threadId: string;
  turnId: string;
  itemId: string;
  server: string;
  tool: string;
  arguments: Record<string, unknown>;
}

export const FLORAL_AGENT_DEVELOPER_INSTRUCTIONS = [
  "FLORAL capability routing policy:",
  "- For macOS screen observation, use floral_peekaboo/image or floral_peekaboo/see. Use floral_vision only for pixel semantics or OCR.",
  "- For any GUI action, floral_peekaboo/see is mandatory immediately before the action. Select the target only from the fresh Snapshot ID and opaque element ID returned by see. Do not infer an actionable target from visual coordinates, arrow direction, OCR, or a screenshot.",
  "- The only currently supported GUI mutation is floral_peekaboo/click. Never use shell/command execution, direct Peekaboo CLI, osascript/AppleScript/System Events, cliclick, or similar automation as a substitute.",
  "- If the requested UI is already in the desired state, do not mutate it and do not request approval.",
  "- After every successful click, call floral_peekaboo/see again before evaluating state or doing another GUI action.",
  "- If see cannot provide a fresh target or the required GUI mutation tool does not exist, state that the action is unsupported instead of falling back to shell or coordinates.",
  "- A local filesystem path or Markdown link/image is not a delivered chat attachment.",
  "- When the user explicitly asks to receive a screenshot or another already-registered artifact, call floral_delivery/send_artifact with the artifactId returned by the trusted producer. Never claim delivery unless that tool reports success.",
  "- For terminal-produced files, first create or copy the final attachment into <cwd>/artifacts/outbound, then call floral_delivery/register_outbound_file, then floral_delivery/send_artifact. Do not register or send arbitrary paths outside that staging root.",
].join("\n");

const FLORAL_DELIVERY_DYNAMIC_TOOLS = [
  {
    type: "namespace",
    name: "floral_delivery",
    description: "FLORAL-controlled delivery of trusted local artifacts to the current chat. Registration is not delivery; outbound DLP is enforced by the host.",
    tools: [
      {
        type: "function",
        name: "register_outbound_file",
        description: "Register one regular file already staged under <cwd>/artifacts/outbound. Returns an artifactId. This does not send the file.",
        inputSchema: {
          type: "object",
          properties: {
            local_path: {
              type: "string",
              minLength: 1,
              maxLength: 4096,
              description: "Absolute path to a file under <cwd>/artifacts/outbound.",
            },
            file_name: {
              type: "string",
              minLength: 1,
              maxLength: 180,
              description: "Optional attachment file name without path separators.",
            },
            caption: {
              type: "string",
              minLength: 1,
              maxLength: 240,
              description: "Optional short caption to keep with the artifact.",
            },
          },
          required: ["local_path"],
          additionalProperties: false,
        },
        deferLoading: false,
      },
      {
        type: "function",
        name: "send_artifact",
        description: "Send one previously registered trusted artifact to the current chat. Accepts artifactId only, never an arbitrary filesystem path. Success means the transport reported the media/file message was sent.",
        inputSchema: {
          type: "object",
          properties: {
            artifact_id: {
              type: "string",
              pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$",
              description: "Artifact ID returned by a trusted producer or register_outbound_file.",
            },
            caption: {
              type: "string",
              minLength: 1,
              maxLength: 240,
              description: "Optional caption override for this delivery.",
            },
          },
          required: ["artifact_id"],
          additionalProperties: false,
        },
        deferLoading: false,
      },
    ],
  },
] as const;

export class CodexAppServerRuntime implements AgentRuntime {
  readonly name = "codex-app-server";
  readonly #client: CodexRpcClient;
  readonly #defaultModel: string | undefined;
  readonly #turnTimeoutMs: number;
  readonly #approvalPolicy: "never" | "on-request" | "untrusted";
  readonly #sandboxMode: "read-only" | "workspace-write";
  readonly #approvalsReviewer: "user";
  readonly #developerInstructions: string;
  readonly #loadedThreads = new Set<string>();
  readonly #activeTurns = new Map<string, string>();
  readonly #eventHandlers = new Map<string, (event: AgentEvent) => void>();
  readonly #approvalHandlers = new Map<string, AgentApprovalHandler>();
  readonly #artifactRegistrationHandlers = new Map<string, AgentArtifactRegistrationHandler>();
  readonly #artifactDeliveryHandlers = new Map<string, AgentArtifactDeliveryHandler>();
  readonly #approvalItemSummaries = new Map<string, string>();
  readonly #inFlightMcpToolCalls = new Map<string, InFlightMcpToolCall>();
  #started = false;

  constructor(options: CodexAppServerOptions) {
    this.#client = new CodexRpcClient({
      command: options.command,
      args: options.args,
      requestTimeoutMs: options.requestTimeoutMs,
      cwd: options.processCwd,
      env: options.processEnv,
    });
    this.#defaultModel = options.defaultModel;
    this.#turnTimeoutMs = options.requestTimeoutMs;
    this.#approvalPolicy = options.approvalPolicy ?? "never";
    this.#sandboxMode = options.sandboxMode ?? "read-only";
    this.#approvalsReviewer = options.approvalsReviewer ?? "user";
    this.#developerInstructions = options.developerInstructions?.trim()
      || FLORAL_AGENT_DEVELOPER_INSTRUCTIONS;
    this.#client.on("serverRequest", (request: CodexServerRequest) => {
      void this.#handleServerRequest(request).catch(() => {
        this.#respondSafely(request.id, undefined, {
          code: -32603,
          message: "FLORAL rejected an approval request after an internal authorization error",
        });
      });
    });
  }

  async start(): Promise<void> {
    if (this.#started) return;

    await this.#client.start();
    try {
      await this.#client.initialize(
        {
          name: "mac_agent_gateway",
          title: "Mac Agent Gateway",
          version: "0.1.0",
        },
        { experimentalApi: true },
      );
      this.#started = true;
    } catch (error) {
      await this.#client.stop();
      throw error;
    }
  }

  async run(request: AgentRunRequest, onEvent?: (event: AgentEvent) => void): Promise<AgentRunResult> {
    this.#ensureStarted();

    const cwd = resolve(request.cwd);
    const threadId = request.threadId
      ? await this.#resumeOrRecoverThread(request, cwd)
      : await this.#startThread(request, cwd);

    onEvent?.({ type: "run.started", threadId });
    if (onEvent) this.#eventHandlers.set(threadId, onEvent);
    if (request.approvalHandler) this.#approvalHandlers.set(threadId, request.approvalHandler);
    if (request.artifactRegistrationHandler) {
      this.#artifactRegistrationHandlers.set(threadId, request.artifactRegistrationHandler);
    }
    if (request.artifactDeliveryHandler) {
      this.#artifactDeliveryHandlers.set(threadId, request.artifactDeliveryHandler);
    }

    let streamedText = "";
    let authoritativeText = "";
    let lastAgentMessageText = "";
    let errorNotification: unknown;
    let activeTurnId: string | undefined;
    let bufferedTerminal: TurnCompletedParams | undefined;
    let terminalSettled = false;
    let resolveTerminal: ((value: TurnTerminalState) => void) | undefined;
    let rejectTerminal: ((reason: Error) => void) | undefined;

    const terminalPromise = new Promise<TurnTerminalState>((resolve, reject) => {
      resolveTerminal = resolve;
      rejectTerminal = reject;
    });

    const settleTerminal = (params: TurnCompletedParams) => {
      if (terminalSettled) return;
      if (!activeTurnId) {
        bufferedTerminal = params;
        return;
      }
      if (params.turn.id !== activeTurnId) return;
      if (params.threadId && params.threadId !== threadId) return;
      terminalSettled = true;
      resolveTerminal?.({ params, errorNotification });
    };

    const deltaListener = (value: unknown) => {
      const params = value as AgentDeltaParams;
      if (!matchesTurn(params, threadId, activeTurnId)) return;
      const delta = readTextDelta(params);
      if (!delta) return;
      streamedText += delta;
      onEvent?.({ type: "assistant.delta", text: delta });
    };

    const itemStartedListener = (value: unknown) => {
      const params = value as ItemLifecycleParams;
      if (!matchesTurn(params, threadId, activeTurnId)) return;

      // Any tool/side-effect work that starts after a narrative message turns
      // that narrative into commentary, not a safe final-answer candidate.
      // Reset streamed fallback too so a pre-tool "I'll search..." delta
      // cannot be returned as the final answer when the provider never closes
      // the tool loop with a post-tool message.
      if (isAgentWorkItem(params.item)) {
        lastAgentMessageText = "";
        streamedText = "";
      }

      const itemId = params.item?.id;
      if (itemId) {
        const approvalSummary = summarizeApprovalItem(params.item);
        if (approvalSummary) this.#approvalItemSummaries.set(approvalItemKey(threadId, itemId), approvalSummary);
      }

      const inFlightMcpTool = readInFlightMcpToolCall(params, threadId);
      if (inFlightMcpTool) {
        this.#inFlightMcpToolCalls.set(
          approvalItemKey(threadId, inFlightMcpTool.itemId),
          inFlightMcpTool,
        );
      }

      const tool = readMcpToolEvent(params.item);
      if (!tool) return;
      onEvent?.({
        type: "tool.started",
        name: tool.name,
        detail: tool.detail,
      });
    };

    const itemCompletedListener = (value: unknown) => {
      const params = value as ItemLifecycleParams;
      if (!matchesTurn(params, threadId, activeTurnId)) return;

      const itemId = params.item?.id;
      if (itemId) {
        const key = approvalItemKey(threadId, itemId);
        this.#approvalItemSummaries.delete(key);
        this.#inFlightMcpToolCalls.delete(key);
      }

      const artifact = readRegisteredMcpArtifact(params.item);
      if (artifact) {
        onEvent?.({ type: "artifact.registered", artifact });
      }

      const tool = readMcpToolEvent(params.item);
      if (tool) {
        onEvent?.({
          type: "tool.completed",
          name: tool.name,
          detail: tool.detail,
        });
        return;
      }

      if (params.item?.type !== "agentMessage" || typeof params.item.text !== "string") return;
      if (params.item.phase === "final_answer") {
        authoritativeText = params.item.text;
        return;
      }
      if (params.item.phase === "commentary") {
        lastAgentMessageText = "";
        streamedText = "";
        return;
      }
      // Older/variant app-server surfaces may omit phase. Keep an unphased
      // message as a fallback only until later tool work invalidates it.
      lastAgentMessageText = params.item.text;
    };

    const errorListener = (value: unknown) => {
      const params = value as ErrorNotificationParams;
      if (!matchesTurn(params, threadId, activeTurnId)) return;
      errorNotification = params.error ?? value;
    };

    const turnCompletedListener = (value: unknown) => {
      const params = value as TurnCompletedParams;
      if (!params?.turn?.id) return;
      settleTerminal(params);
    };

    const processErrorListener = (error: CodexRuntimeError) => {
      if (terminalSettled) return;
      terminalSettled = true;
      rejectTerminal?.(error);
    };

    const exitListener = (event: CodexExitEvent) => {
      if (terminalSettled) return;
      terminalSettled = true;
      rejectTerminal?.(event.error);
    };

    this.#client.on("notification:item/agentMessage/delta", deltaListener);
    this.#client.on("notification:item/started", itemStartedListener);
    this.#client.on("notification:item/completed", itemCompletedListener);
    this.#client.on("notification:error", errorListener);
    this.#client.on("notification:turn/completed", turnCompletedListener);
    this.#client.on("processError", processErrorListener);
    this.#client.on("exit", exitListener);

    try {
      const turnParams: Record<string, unknown> = {
        threadId,
        input: [{ type: "text", text: request.text }],
        cwd,
        approvalPolicy: toAppServerApprovalPolicy(this.#approvalPolicy),
        approvalsReviewer: this.#approvalsReviewer,
        sandboxPolicy: buildTurnSandboxPolicy(this.#sandboxMode, cwd),
      };
      const model = request.model ?? this.#defaultModel;
      if (model) turnParams.model = model;

      const turn = await this.#client.request<TurnResponse>("turn/start", turnParams);
      activeTurnId = turn.turn.id;
      this.#activeTurns.set(threadId, activeTurnId);
      if (bufferedTerminal) settleTerminal(bufferedTerminal);

      const terminal = await withTimeout(
        terminalPromise,
        this.#turnTimeoutMs,
        () => codexRequestTimeout("turn/completed", this.#turnTimeoutMs),
      );
      const status = terminal.params.turn.status;

      if (status === "interrupted") {
        throw new CodexRuntimeError({
          kind: "interrupted",
          message: `Codex turn interrupted: ${activeTurnId}`,
          retryable: true,
          data: terminal.params,
        });
      }
      if (status === "failed") {
        throw classifyCodexFailure(
          terminal.params.turn.error ?? terminal.errorNotification ?? terminal.params,
          { method: "turn/start", fallbackMessage: `Codex turn failed: ${activeTurnId}` },
        );
      }
      if (status !== "completed") {
        throw codexProtocolError(`Unexpected Codex turn status: ${status}`);
      }

      const finalText = authoritativeText
        || readFinalAgentText(terminal.params.turn.items)
        || lastAgentMessageText
        || streamedText;
      if (!finalText) {
        throw codexProtocolError(
          "Codex turn completed without a final agent message",
        );
      }

      const result = {
        threadId,
        finalText,
      };
      onEvent?.({ type: "run.completed", ...result });
      return result;
    } catch (error) {
      if (activeTurnId && error instanceof CodexRuntimeError && error.kind === "request_timeout") {
        await this.#interruptBestEffort(threadId, activeTurnId);
      }
      const wrapped = error instanceof CodexRuntimeError
        ? error
        : classifyCodexFailure(error, { fallbackMessage: "Codex run failed" });
      onEvent?.({ type: "run.failed", threadId, message: wrapped.message });
      throw wrapped;
    } finally {
      this.#client.off("notification:item/agentMessage/delta", deltaListener);
      this.#client.off("notification:item/started", itemStartedListener);
      this.#client.off("notification:item/completed", itemCompletedListener);
      this.#client.off("notification:error", errorListener);
      this.#client.off("notification:turn/completed", turnCompletedListener);
      this.#client.off("processError", processErrorListener);
      this.#client.off("exit", exitListener);
      this.#activeTurns.delete(threadId);
      this.#eventHandlers.delete(threadId);
      this.#approvalHandlers.delete(threadId);
      this.#artifactRegistrationHandlers.delete(threadId);
      this.#artifactDeliveryHandlers.delete(threadId);
      this.#deleteApprovalItemSummaries(threadId);
      this.#deleteInFlightMcpToolCalls(threadId);
    }
  }

  async interrupt(threadId: string, turnId?: string): Promise<void> {
    this.#ensureStarted();
    const resolvedTurnId = turnId ?? this.#activeTurns.get(threadId);
    if (!resolvedTurnId) {
      throw new CodexRuntimeError({
        kind: "bad_request",
        message: `No active Codex turn is known for thread ${threadId}`,
        retryable: false,
      });
    }
    await this.#client.request("turn/interrupt", { threadId, turnId: resolvedTurnId });
  }

  async stop(): Promise<void> {
    this.#started = false;
    this.#loadedThreads.clear();
    this.#activeTurns.clear();
    this.#eventHandlers.clear();
    this.#approvalHandlers.clear();
    this.#artifactRegistrationHandlers.clear();
    this.#artifactDeliveryHandlers.clear();
    this.#approvalItemSummaries.clear();
    this.#inFlightMcpToolCalls.clear();
    await this.#client.stop();
  }

  async #resumeOrRecoverThread(request: AgentRunRequest, cwd: string): Promise<string> {
    const requestedThreadId = request.threadId;
    if (!requestedThreadId) return await this.#startThread(request, cwd);

    try {
      return await this.#resumeThread(requestedThreadId);
    } catch (error) {
      if (!isUnavailableThreadResume(error)) throw error;

      // No turn has started yet, so replacing a missing local thread cannot
      // duplicate provider or tool side effects. The caller persists the new ID.
      process.stderr.write("codex.thread_resume=stale_reset\n");
      return await this.#startThread(request, cwd);
    }
  }

  async #startThread(request: AgentRunRequest, cwd: string): Promise<string> {
    // Keep thread bootstrap capability-neutral. The real approval and sandbox
    // ceiling is applied immediately before every turn via turn/start below.
    // This avoids app-server's thread/start project-trust/config mutation path
    // while preserving one-turn-at-a-time FLORAL authorization semantics.
    const params: Record<string, unknown> = {
      cwd,
      developerInstructions: this.#developerInstructions,
      dynamicTools: FLORAL_DELIVERY_DYNAMIC_TOOLS,
    };
    const model = request.model ?? this.#defaultModel;
    if (model) params.model = model;

    const response = await this.#client.request<ThreadResponse>("thread/start", params);
    if (!response.thread?.id) {
      throw codexProtocolError("thread/start returned no thread id");
    }
    this.#loadedThreads.add(response.thread.id);
    return response.thread.id;
  }

  async #resumeThread(threadId: string): Promise<string> {
    if (this.#loadedThreads.has(threadId)) return threadId;

    // Resuming only restores conversation history. Current approval/sandbox
    // policy is always re-applied by the following turn/start request.
    const response = await this.#client.request<ThreadResponse>("thread/resume", {
      threadId,
      developerInstructions: this.#developerInstructions,
    });
    const resumedId = response.thread?.id;
    if (!resumedId) {
      throw codexProtocolError("thread/resume returned no thread id");
    }
    if (resumedId !== threadId) {
      throw codexProtocolError(`thread/resume returned ${resumedId}, expected ${threadId}`);
    }
    this.#loadedThreads.add(threadId);
    return threadId;
  }

  async #handleServerRequest(request: CodexServerRequest): Promise<void> {
    const params = asRecord(request.params);
    const threadId = readString(params?.threadId);
    const onEvent = threadId ? this.#eventHandlers.get(threadId) : undefined;

    if (request.method === "currentTime/read") {
      this.#respondSafely(request.id, { currentTimeAt: Math.floor(Date.now() / 1_000) });
      return;
    }

    if (request.method === "item/tool/call") {
      await this.#handleArtifactDynamicToolCall(request);
      return;
    }

    if (
      request.method === "item/commandExecution/requestApproval"
      || request.method === "item/fileChange/requestApproval"
    ) {
      if (
        request.method === "item/commandExecution/requestApproval"
        && isGuiAutomationShellBypass(readString(params?.command))
      ) {
        process.stderr.write("codex.gui_shell_bypass=declined\n");
        this.#respondSafely(request.id, { decision: "decline" });
        return;
      }

      const itemId = readString(params?.itemId);
      const itemSummary = threadId && itemId
        ? this.#approvalItemSummaries.get(approvalItemKey(threadId, itemId))
        : undefined;
      const approval = buildCodexApprovalRequest(request, itemSummary);
      onEvent?.({
        type: "approval.requested",
        requestId: approval.requestId,
        capability: approval.capability,
        kind: approval.kind,
        detail: { summary: approval.summary },
      });

      const handler = threadId ? this.#approvalHandlers.get(threadId) : undefined;
      const decision = handler
        ? await handler(approval).catch(() => "deny" as const)
        : "deny";
      this.#respondSafely(request.id, { decision: decision === "approve" ? "accept" : "decline" });
      return;
    }

    if (request.method === "item/permissions/requestApproval") {
      const approval: AgentApprovalRequest = {
        requestId: String(request.id),
        kind: "permission-profile",
        capability: "system.admin",
        summary: "Codex 请求扩大当前沙箱权限范围。",
        source: "codex",
      };
      onEvent?.({
        type: "approval.requested",
        requestId: approval.requestId,
        capability: approval.capability,
        kind: approval.kind,
        detail: { summary: approval.summary },
      });
      // Granular permission grants are deliberately not remotely delegable in
      // Phase 5.3. Returning an empty subset is fail-closed and keeps the
      // stronger local-confirmation boundary intact.
      this.#respondSafely(request.id, { scope: "turn", permissions: {} });
      return;
    }

    if (request.method === "mcpServer/elicitation/request") {
      const serverId = readString(params?.serverName);
      const correlatedTurnId = readString(params?.turnId)
        ?? (threadId ? this.#activeTurns.get(threadId) : undefined);
      const context = threadId && correlatedTurnId && serverId
        ? this.#resolveMcpToolApprovalContext(threadId, correlatedTurnId, serverId)
        : undefined;
      const approval = buildMcpToolApprovalRequest(request, context);
      if (!approval) {
        this.#respondSafely(request.id, { action: "decline", content: null, _meta: null });
        return;
      }
      onEvent?.({
        type: "approval.requested",
        requestId: approval.requestId,
        capability: approval.capability,
        kind: approval.kind,
        detail: { summary: approval.summary },
      });
      const handler = threadId ? this.#approvalHandlers.get(threadId) : undefined;
      const decision = handler
        ? await handler(approval).catch(() => "deny" as const)
        : "deny";
      this.#respondSafely(
        request.id,
        decision === "approve"
          ? { action: "accept", content: {}, _meta: null }
          : { action: "decline", content: null, _meta: null },
      );
      return;
    }

    this.#respondSafely(request.id, undefined, {
      code: -32601,
      message: `FLORAL does not support interactive server request: ${request.method}`,
    });
  }

  async #handleArtifactDynamicToolCall(
    request: CodexServerRequest,
  ): Promise<void> {
    const params = asPlainRecord(request.params);
    const threadId = readString(params?.threadId);
    const turnId = readString(params?.turnId);
    const namespace = readString(params?.namespace);
    const tool = readString(params?.tool);
    const activeTurnId = threadId ? this.#activeTurns.get(threadId) : undefined;

    if (
      !threadId
      || !turnId
      || activeTurnId !== turnId
      || namespace !== "floral_delivery"
      || !tool
    ) {
      this.#respondSafely(
        request.id,
        dynamicToolResponse(false, "artifact_delivery=denied\nreason=invalid-context"),
      );
      return;
    }

    const argumentsValue = asPlainRecord(params?.arguments);
    if (!argumentsValue) {
      this.#respondSafely(
        request.id,
        dynamicToolResponse(false, "artifact_delivery=denied\nreason=invalid-arguments"),
      );
      return;
    }

    if (tool === "register_outbound_file") {
      const parsed = parseRegisterOutboundFileArguments(argumentsValue);
      const handler = this.#artifactRegistrationHandlers.get(threadId);
      if (!parsed || !handler) {
        this.#respondSafely(
          request.id,
          dynamicToolResponse(false, "artifact_registration=denied\nreason=handler-or-arguments"),
        );
        return;
      }
      const result = await handler(parsed).catch(() => ({
        status: "denied" as const,
        reason: "registration-handler-error",
      }));
      this.#respondSafely(
        request.id,
        result.status === "registered"
          ? dynamicToolResponse(
              true,
              `artifact_registration=registered\nartifactId=${result.artifactId}`,
            )
          : dynamicToolResponse(
              false,
              `artifact_registration=denied\nreason=${safeDynamicToolToken(result.reason)}`,
            ),
      );
      return;
    }

    if (tool === "send_artifact") {
      const parsed = parseSendArtifactArguments(argumentsValue);
      const handler = this.#artifactDeliveryHandlers.get(threadId);
      if (!parsed || !handler) {
        this.#respondSafely(
          request.id,
          dynamicToolResponse(false, "artifact_delivery=denied\nreason=handler-or-arguments"),
        );
        return;
      }
      const result = await handler(parsed).catch(() => ({
        status: "failed" as const,
        artifactId: parsed.artifactId,
        reason: "delivery-handler-error",
      }));
      this.#respondSafely(
        request.id,
        result.status === "sent"
          ? dynamicToolResponse(
              true,
              [
                "artifact_delivery=sent",
                `artifactId=${result.artifactId}`,
                `kind=${result.kind}`,
                `bytes=${String(result.byteLength)}`,
              ].join("\n"),
            )
          : dynamicToolResponse(
              false,
              [
                `artifact_delivery=${result.status}`,
                `artifactId=${result.artifactId}`,
                `reason=${safeDynamicToolToken(result.reason)}`,
              ].join("\n"),
            ),
      );
      return;
    }

    this.#respondSafely(
      request.id,
      dynamicToolResponse(false, "artifact_delivery=denied\nreason=unsupported-tool"),
    );
  }

  #resolveMcpToolApprovalContext(
    threadId: string,
    turnId: string,
    serverId: string,
  ): InFlightMcpToolCall | undefined {
    const matches = [...this.#inFlightMcpToolCalls.values()].filter((call) =>
      call.threadId === threadId
      && call.turnId === turnId
      && call.server === serverId
      && capabilityForMcpTool(call.server, call.tool) === "application.control"
    );
    // The real Codex elicitation intentionally does not carry tool_name. Only
    // correlate when exactly one in-flight control-capable MCP call exists for
    // this thread/turn/server. Parallel ambiguous mutations fail closed.
    return matches.length === 1 ? matches[0] : undefined;
  }

  #deleteApprovalItemSummaries(threadId: string): void {
    const prefix = `${threadId}:`;
    for (const key of this.#approvalItemSummaries.keys()) {
      if (key.startsWith(prefix)) this.#approvalItemSummaries.delete(key);
    }
  }

  #deleteInFlightMcpToolCalls(threadId: string): void {
    const prefix = `${threadId}:`;
    for (const key of this.#inFlightMcpToolCalls.keys()) {
      if (key.startsWith(prefix)) this.#inFlightMcpToolCalls.delete(key);
    }
  }

  #respondSafely(
    id: number | string,
    result?: unknown,
    error?: { code: number; message: string; data?: unknown },
  ): void {
    try {
      this.#client.respond(id, result, error);
    } catch {
      // A concurrent process-exit event or turn timeout will surface the failure.
    }
  }

  async #interruptBestEffort(threadId: string, turnId: string): Promise<void> {
    try {
      await this.#client.request("turn/interrupt", { threadId, turnId });
    } catch {
      // The original timeout/error remains the actionable failure.
    }
  }

  #ensureStarted(): void {
    if (!this.#started) {
      throw new CodexRuntimeError({
        kind: "process_exit",
        message: "CodexAppServerRuntime.start() must complete before run()",
        retryable: true,
      });
    }
  }
}


function toAppServerApprovalPolicy(
  policy: "never" | "on-request" | "untrusted",
): "never" | "on-request" | "untrusted" {
  // Codex 0.146.1 app-server accepts the config-compatible approval values
  // directly. The README example used the internal variant-style
  // "unlessTrusted", but the generated TurnStartParams schema accepts
  // "untrusted" instead.
  return policy;
}


function buildTurnSandboxPolicy(
  mode: "read-only" | "workspace-write",
  cwd: string,
): Record<string, unknown> {
  if (mode === "read-only") return { type: "readOnly" };
  return {
    type: "workspaceWrite",
    writableRoots: [resolve(cwd)],
    networkAccess: false,
  };
}

function approvalItemKey(threadId: string, itemId: string): string {
  return `${threadId}:${itemId}`;
}

function summarizeApprovalItem(item: ItemLifecycleParams["item"]): string | undefined {
  if (!item) return undefined;
  if (item.type === "fileChange") {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const summaries = changes.slice(0, 8).map((change) => {
      const path = redactApprovalText(readString(change?.path)) ?? "<unknown-path>";
      const kind = redactApprovalText(readString(change?.kind));
      return kind ? `${kind}:${path}` : path;
    });
    if (summaries.length === 0) return undefined;
    const omitted = changes.length - summaries.length;
    const text = `${summaries.join(", ")}${omitted > 0 ? `, +${String(omitted)} more` : ""}`;
    return redactApprovalText(text);
  }
  if (item.type === "commandExecution") {
    const command = redactApprovalText(readString(item.command));
    const cwd = redactApprovalText(readString(item.cwd));
    if (!command) return undefined;
    return cwd ? `${command} (cwd=${cwd})` : command;
  }
  return undefined;
}

function buildCodexApprovalRequest(
  request: CodexServerRequest,
  itemSummary?: string,
): AgentApprovalRequest {
  const params = asRecord(request.params);
  const reason = redactApprovalText(readString(params?.reason));
  if (request.method === "item/fileChange/requestApproval") {
    return {
      requestId: String(request.id),
      kind: "file-change",
      capability: "files.write",
      summary: itemSummary
        ? `Codex 请求修改工作区文件：${itemSummary}${reason ? `；原因=${reason}` : ""}`
        : reason
          ? `Codex 请求修改工作区文件：${reason}`
          : "Codex 请求修改工作区文件。",
      source: "codex",
    };
  }

  const command = redactApprovalText(readString(params?.command));
  return {
    requestId: String(request.id),
    kind: "command-execution",
    capability: "shell.execute",
    summary: command
      ? `Codex 请求执行需要额外权限的命令：${command}`
      : reason
        ? `Codex 请求执行需要额外权限的命令：${reason}`
        : "Codex 请求执行一个需要额外权限的命令。",
    source: "codex",
  };
}

function buildMcpToolApprovalRequest(
  request: CodexServerRequest,
  context: InFlightMcpToolCall | undefined,
): AgentApprovalRequest | undefined {
  const params = asRecord(request.params);
  if (readString(params?.mode) !== "form") return undefined;
  const metadata = asPlainRecord(params?._meta);
  if (readString(metadata?.codex_approval_kind) !== "mcp_tool_call") return undefined;

  const serverId = readString(params?.serverName);
  if (!context || serverId !== context.server || context.tool !== "click") return undefined;
  const toolName = context.tool;

  const schema = asPlainRecord(params?.requestedSchema);
  const properties = asPlainRecord(schema?.properties);
  if (schema?.type !== "object" || !properties || Object.keys(properties).length !== 0) {
    return undefined;
  }

  const capability = capabilityForMcpTool(serverId, toolName);
  if (capability !== "application.control") return undefined;
  const toolParams = asPlainRecord(metadata?.tool_params);
  if (!toolParams || !sameMcpClickApprovalArguments(toolParams, context.arguments)) {
    return undefined;
  }
  const intent = redactApprovalText(readString(context.arguments.intent));
  const summary = intent
    ? `MCP ${serverId}/${toolName} 请求执行一次操作：${intent}`
    : `MCP ${serverId}/${toolName} 请求执行一次 ${capability} 操作。`;
  return {
    requestId: String(request.id),
    kind: "mcp-tool",
    capability,
    summary,
    source: "mcp",
    mcpServerId: serverId,
    mcpToolName: toolName,
  };
}

function sameMcpClickApprovalArguments(
  metadataArguments: Record<string, unknown>,
  lifecycleArguments: Record<string, unknown>,
): boolean {
  const expectedKeys = ["intent", "on", "snapshot"];
  const metadataKeys = Object.keys(metadataArguments).sort();
  const lifecycleKeys = Object.keys(lifecycleArguments).sort();
  if (JSON.stringify(metadataKeys) !== JSON.stringify(expectedKeys)) return false;
  if (JSON.stringify(lifecycleKeys) !== JSON.stringify(expectedKeys)) return false;
  return expectedKeys.every((key) =>
    readString(metadataArguments[key]) === readString(lifecycleArguments[key])
  );
}

function redactApprovalText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value
    .replace(/[\u0000-\u001F\u007F]+/gu, " ")
    .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s]+/giu, "$1=<redacted>")
    .replace(/(--?(?:api[_-]?key|token|secret|password))\s+(?!<redacted>)[^\s]+/giu, "$1 <redacted>")
    .replace(/\bbearer\s+[A-Za-z0-9._~+\/=-]+/giu, "Bearer <redacted>")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) return undefined;
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 237)}...`;
}

function isUnavailableThreadResume(error: unknown): boolean {
  if (!(error instanceof CodexRuntimeError)) return false;
  if (error.method !== "thread/resume") return false;

  // Codex currently overloads JSON-RPC -32600 for both genuinely stale
  // rollouts and unrelated failures such as malformed configuration. Only
  // reset the persisted thread when the bounded server message actually says
  // the rollout/thread is unavailable; otherwise preserve the original error.
  const message = error.message.toLowerCase();
  return message.includes("thread not loaded")
    || message.includes("thread not found")
    || message.includes("no rollout found");
}

function readInFlightMcpToolCall(
  params: ItemLifecycleParams,
  fallbackThreadId: string,
): InFlightMcpToolCall | undefined {
  const item = params.item;
  if (
    item?.type !== "mcpToolCall"
    || typeof item.id !== "string"
    || typeof item.server !== "string"
    || typeof item.tool !== "string"
    || capabilityForMcpTool(item.server, item.tool) !== "application.control"
  ) {
    return undefined;
  }
  const turnId = readString(params.turnId);
  const argumentsValue = asPlainRecord(item.arguments);
  if (!turnId || !argumentsValue) return undefined;
  return {
    threadId: readString(params.threadId) ?? fallbackThreadId,
    turnId,
    itemId: item.id,
    server: item.server,
    tool: item.tool,
    arguments: argumentsValue,
  };
}

function readRegisteredMcpArtifact(
  item: ItemLifecycleParams["item"],
): AgentArtifact | undefined {
  if (
    item?.type !== "mcpToolCall"
    || item.server !== "floral_peekaboo"
    || (item.tool !== "image" && item.tool !== "see")
    || (item.error !== undefined && item.error !== null)
  ) {
    return undefined;
  }

  const result = asPlainRecord(item.result);
  const content = Array.isArray(result?.content) ? result.content : [];
  const texts = content.flatMap((entry) => {
    const block = asPlainRecord(entry);
    return block?.type === "text" && typeof block.text === "string"
      ? [block.text]
      : [];
  });
  const artifactId = readUniqueTaggedLine(texts, "artifactId");
  const artifactPath = readUniqueTaggedLine(texts, "artifactPath");
  if (
    !artifactId
    || !artifactPath
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/u.test(artifactId)
  ) {
    return undefined;
  }

  return {
    id: artifactId,
    kind: "image",
    localPath: artifactPath,
    source: {
      type: "mcp",
      serverId: item.server,
      toolName: item.tool,
    },
  };
}

function readUniqueTaggedLine(texts: string[], key: string): string | undefined {
  const prefix = `${key}=`;
  const matches: string[] = [];
  for (const text of texts) {
    for (const line of text.split(/\r?\n/u)) {
      if (!line.startsWith(prefix)) continue;
      const value = line.slice(prefix.length).trim();
      if (value) matches.push(value);
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
}

function readMcpToolEvent(
  item: ItemLifecycleParams["item"],
): { name: string; detail: Record<string, unknown> } | undefined {
  if (
    item?.type !== "mcpToolCall"
    || typeof item.server !== "string"
    || typeof item.tool !== "string"
  ) {
    return undefined;
  }

  return {
    name: `${item.server}/${item.tool}`,
    detail: {
      server: item.server,
      tool: item.tool,
      status: item.status ?? "unknown",
      ...(item.error !== undefined ? { error: item.error } : {}),
    },
  };
}

function matchesTurn(
  params: { threadId?: string; turnId?: string },
  threadId: string,
  turnId: string | undefined,
): boolean {
  if (params.threadId && params.threadId !== threadId) return false;
  if (turnId && params.turnId && params.turnId !== turnId) return false;
  return true;
}

function readTextDelta(value: AgentDeltaParams): string | undefined {
  if (typeof value.delta === "string") return value.delta;
  if (typeof value.text === "string") return value.text;
  return undefined;
}

function readFinalAgentText(items: unknown[] | undefined): string | undefined {
  if (!items) return undefined;

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = asRecord(items[index]);
    if (
      item?.type === "agentMessage"
      && item.phase === "final_answer"
      && typeof item.text === "string"
    ) {
      return item.text;
    }
  }

  // Some app-server builds omit `phase`. In that case only an agent message
  // that occurs after the most recent work item may be treated as final. A
  // pre-tool narrative must never survive as the terminal answer.
  let candidate: string | undefined;
  for (const value of items) {
    const item = asRecord(value);
    if (!item) continue;
    if (isAgentWorkItem(item)) {
      candidate = undefined;
      continue;
    }
    if (
      item.type === "agentMessage"
      && item.phase !== "commentary"
      && typeof item.text === "string"
    ) {
      candidate = item.text;
    }
  }
  return candidate;
}

function isAgentWorkItem(
  item: ItemLifecycleParams["item"] | Record<string, unknown> | undefined,
): boolean {
  const type = item?.type;
  if (typeof type !== "string" || type.length === 0) return false;
  return !new Set([
    "agentMessage",
    "reasoning",
    "plan",
    "userMessage",
  ]).has(type);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

function asPlainRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isGuiAutomationShellBypass(command: string | undefined): boolean {
  if (!command) return false;
  const normalized = command.toLowerCase();
  if (/\bosascript\b/u.test(normalized) || /\bcliclick\b/u.test(normalized)) {
    return true;
  }
  return /\bpeekaboo\b[\s\S]{0,240}\b(click|type|press|scroll|hotkey|drag|paste|move|swipe)\b/u
    .test(normalized);
}

function parseRegisterOutboundFileArguments(
  value: Record<string, unknown>,
): Parameters<AgentArtifactRegistrationHandler>[0] | undefined {
  const keys = Object.keys(value).sort();
  if (keys.some((key) => !["caption", "file_name", "local_path"].includes(key))) {
    return undefined;
  }
  const localPath = readString(value.local_path);
  if (!localPath || localPath.length > 4096 || /[\r\n\0]/u.test(localPath)) {
    return undefined;
  }
  const fileName = readOptionalToolText(value.file_name, 180);
  const caption = readOptionalToolText(value.caption, 240);
  if (value.file_name !== undefined && !fileName) return undefined;
  if (value.caption !== undefined && !caption) return undefined;
  if (fileName && (fileName.includes("/") || fileName.includes("\\"))) return undefined;
  return {
    localPath,
    ...(fileName ? { fileName } : {}),
    ...(caption ? { caption } : {}),
  };
}

function parseSendArtifactArguments(
  value: Record<string, unknown>,
): Parameters<AgentArtifactDeliveryHandler>[0] | undefined {
  const keys = Object.keys(value).sort();
  if (keys.some((key) => !["artifact_id", "caption"].includes(key))) {
    return undefined;
  }
  const artifactId = readString(value.artifact_id);
  if (!artifactId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/u.test(artifactId)) {
    return undefined;
  }
  const caption = readOptionalToolText(value.caption, 240);
  if (value.caption !== undefined && !caption) return undefined;
  return {
    artifactId,
    ...(caption ? { caption } : {}),
  };
}

function readOptionalToolText(value: unknown, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return undefined;
  const normalized = value
    .replace(/[\u0000-\u001F\u007F]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized || Array.from(normalized).length > maxLength) return undefined;
  return normalized;
}

function dynamicToolResponse(
  success: boolean,
  text: string,
): { contentItems: Array<{ type: "inputText"; text: string }>; success: boolean } {
  return {
    success,
    contentItems: [{ type: "inputText", text }],
  };
}

function safeDynamicToolToken(value: string): string {
  const normalized = value
    .replace(/[^A-Za-z0-9._:-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return normalized.slice(0, 96) || "unknown";
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  createError: () => Error,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(createError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
