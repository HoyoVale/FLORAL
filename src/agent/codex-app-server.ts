import { resolve } from "node:path";
import type { AgentRuntime } from "../core/contracts.js";
import type {
  AgentApprovalHandler,
  AgentApprovalRequest,
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
  processCwd?: string | undefined;
  processEnv?: NodeJS.ProcessEnv | undefined;
}

interface TurnTerminalState {
  params: TurnCompletedParams;
  errorNotification: unknown;
}

export class CodexAppServerRuntime implements AgentRuntime {
  readonly name = "codex-app-server";
  readonly #client: CodexRpcClient;
  readonly #defaultModel: string | undefined;
  readonly #turnTimeoutMs: number;
  readonly #approvalPolicy: "never" | "on-request" | "untrusted";
  readonly #sandboxMode: "read-only" | "workspace-write";
  readonly #approvalsReviewer: "user";
  readonly #loadedThreads = new Set<string>();
  readonly #activeTurns = new Map<string, string>();
  readonly #eventHandlers = new Map<string, (event: AgentEvent) => void>();
  readonly #approvalHandlers = new Map<string, AgentApprovalHandler>();
  readonly #approvalItemSummaries = new Map<string, string>();
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
      await this.#client.initialize({
        name: "mac_agent_gateway",
        title: "Mac Agent Gateway",
        version: "0.1.0",
      });
      this.#started = true;
    } catch (error) {
      await this.#client.stop();
      throw error;
    }
  }

  async run(request: AgentRunRequest, onEvent?: (event: AgentEvent) => void): Promise<AgentRunResult> {
    this.#ensureStarted();

    const threadId = request.threadId
      ? await this.#resumeOrRecoverThread(request)
      : await this.#startThread(request);

    onEvent?.({ type: "run.started", threadId });
    if (onEvent) this.#eventHandlers.set(threadId, onEvent);
    if (request.approvalHandler) this.#approvalHandlers.set(threadId, request.approvalHandler);

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
      const itemId = params.item?.id;
      if (itemId) {
        const approvalSummary = summarizeApprovalItem(params.item);
        if (approvalSummary) this.#approvalItemSummaries.set(approvalItemKey(threadId, itemId), approvalSummary);
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
      if (itemId) this.#approvalItemSummaries.delete(approvalItemKey(threadId, itemId));

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
      } else {
        lastAgentMessageText = params.item.text;
      }
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
        cwd: request.cwd,
        approvalPolicy: toAppServerApprovalPolicy(this.#approvalPolicy),
        approvalsReviewer: this.#approvalsReviewer,
        sandboxPolicy: buildTurnSandboxPolicy(this.#sandboxMode, request.cwd),
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

      const result = {
        threadId,
        finalText: authoritativeText
          || lastAgentMessageText
          || readFinalAgentText(terminal.params.turn.items)
          || streamedText
          || "Codex turn completed without an agent message.",
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
      this.#deleteApprovalItemSummaries(threadId);
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
    this.#approvalItemSummaries.clear();
    await this.#client.stop();
  }

  async #resumeOrRecoverThread(request: AgentRunRequest): Promise<string> {
    const requestedThreadId = request.threadId;
    if (!requestedThreadId) return await this.#startThread(request);

    try {
      return await this.#resumeThread(requestedThreadId);
    } catch (error) {
      if (!isUnavailableThreadResume(error)) throw error;

      // No turn has started yet, so replacing a missing local thread cannot
      // duplicate provider or tool side effects. The caller persists the new ID.
      process.stderr.write("codex.thread_resume=stale_reset\n");
      return await this.#startThread(request);
    }
  }

  async #startThread(request: AgentRunRequest): Promise<string> {
    const params: Record<string, unknown> = {
      cwd: request.cwd,
      approvalPolicy: toAppServerApprovalPolicy(this.#approvalPolicy),
      approvalsReviewer: this.#approvalsReviewer,
      sandbox: toAppServerThreadSandbox(this.#sandboxMode),
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

    const response = await this.#client.request<ThreadResponse>("thread/resume", {
      threadId,
      approvalPolicy: toAppServerApprovalPolicy(this.#approvalPolicy),
      approvalsReviewer: this.#approvalsReviewer,
      sandbox: toAppServerThreadSandbox(this.#sandboxMode),
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

    if (
      request.method === "item/commandExecution/requestApproval"
      || request.method === "item/fileChange/requestApproval"
    ) {
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
      this.#respondSafely(request.id, { action: "decline", content: null });
      return;
    }

    this.#respondSafely(request.id, undefined, {
      code: -32601,
      message: `FLORAL does not support interactive server request: ${request.method}`,
    });
  }

  #deleteApprovalItemSummaries(threadId: string): void {
    const prefix = `${threadId}:`;
    for (const key of this.#approvalItemSummaries.keys()) {
      if (key.startsWith(prefix)) this.#approvalItemSummaries.delete(key);
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
): "never" | "onRequest" | "unlessTrusted" {
  if (policy === "untrusted") return "unlessTrusted";
  if (policy === "on-request") return "onRequest";
  return "never";
}

function toAppServerThreadSandbox(
  mode: "read-only" | "workspace-write",
): "readOnly" | "workspaceWrite" {
  return mode === "workspace-write" ? "workspaceWrite" : "readOnly";
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

  return error.kind === "bad_request"
    || error.kind === "protocol"
    || error.kind === "unknown";
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
    if (item?.type === "agentMessage" && typeof item.text === "string") return item.text;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
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
