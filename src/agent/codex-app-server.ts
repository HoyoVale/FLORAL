import type { AgentRuntime } from "../core/contracts.js";
import type { AgentEvent, AgentRunRequest, AgentRunResult } from "../core/types.js";
import { CodexRpcClient } from "./codex-rpc-client.js";

interface ThreadResponse {
  thread: { id: string };
}

interface TurnResponse {
  turn: { id: string };
}

export interface CodexAppServerOptions {
  command: string;
  args: string[];
  requestTimeoutMs: number;
  defaultModel?: string;
}

export class CodexAppServerRuntime implements AgentRuntime {
  readonly name = "codex-app-server";
  readonly #client: CodexRpcClient;
  readonly #defaultModel?: string;

  constructor(options: CodexAppServerOptions) {
    this.#client = new CodexRpcClient({
      command: options.command,
      args: options.args,
      requestTimeoutMs: options.requestTimeoutMs
    });
    this.#defaultModel = options.defaultModel;
  }

  async start(): Promise<void> {
    await this.#client.start();
    await this.#client.initialize({
      name: "mac_agent_gateway",
      title: "Mac Agent Gateway",
      version: "0.1.0"
    });
  }

  async run(request: AgentRunRequest, onEvent?: (event: AgentEvent) => void): Promise<AgentRunResult> {
    const threadId = request.threadId ?? await this.#startThread(request);
    onEvent?.({ type: "run.started", threadId });

    let finalText = "";
    const deltaListener = (params: unknown) => {
      const delta = readTextDelta(params);
      if (delta) {
        finalText += delta;
        onEvent?.({ type: "assistant.delta", text: delta });
      }
    };
    this.#client.on("notification:item/agentMessage/delta", deltaListener);

    try {
      const turn = await this.#client.request<TurnResponse>("turn/start", {
        threadId,
        input: [{ type: "text", text: request.text }],
        cwd: request.cwd,
        model: request.model ?? this.#defaultModel
      });

      await this.#waitForTurnCompletion(turn.turn.id);
      const result = { threadId, finalText: finalText || "Codex turn completed." };
      onEvent?.({ type: "run.completed", ...result });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onEvent?.({ type: "run.failed", threadId, message });
      throw error;
    } finally {
      this.#client.off("notification:item/agentMessage/delta", deltaListener);
    }
  }

  async interrupt(threadId: string, turnId?: string): Promise<void> {
    await this.#client.request("turn/interrupt", { threadId, ...(turnId ? { turnId } : {}) });
  }

  async stop(): Promise<void> {
    await this.#client.stop();
  }

  async #startThread(request: AgentRunRequest): Promise<string> {
    const response = await this.#client.request<ThreadResponse>("thread/start", {
      cwd: request.cwd,
      model: request.model ?? this.#defaultModel,
      sandbox: "workspaceWrite",
      approvalPolicy: "untrusted"
    });
    return response.thread.id;
  }

  #waitForTurnCompletion(turnId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const listener = (params: unknown) => {
        const record = params as { turn?: { id?: string; status?: string } };
        if (record.turn?.id !== turnId) return;
        this.#client.off("notification:turn/completed", listener);
        if (record.turn.status === "failed") {
          reject(new Error(`Codex turn failed: ${turnId}`));
        } else {
          resolve();
        }
      };
      this.#client.on("notification:turn/completed", listener);
    });
  }
}

function readTextDelta(value: unknown): string | undefined {
  const record = value as { delta?: string; text?: string };
  if (typeof record.delta === "string") return record.delta;
  if (typeof record.text === "string") return record.text;
  return undefined;
}
