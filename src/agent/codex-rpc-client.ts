import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";

export interface RpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

export interface CodexRpcClientOptions {
  command: string;
  args: string[];
  cwd?: string;
  requestTimeoutMs: number;
}

export class CodexRpcClient extends EventEmitter {
  #process?: ChildProcessWithoutNullStreams;
  #nextId = 1;
  readonly #pending = new Map<number, PendingRequest>();

  constructor(private readonly options: CodexRpcClientOptions) {
    super();
  }

  async start(): Promise<void> {
    if (this.#process) return;

    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env
    });
    this.#process = child;

    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.#handleLine(line));
    child.stderr.on("data", (chunk) => this.emit("stderr", String(chunk)));
    child.on("error", (error) => this.#failAll(error));
    child.on("exit", (code, signal) => {
      this.#process = undefined;
      const error = new Error(`Codex app-server exited (code=${code}, signal=${signal})`);
      this.#failAll(error);
      this.emit("exit", { code, signal });
    });
  }

  async initialize(clientInfo: { name: string; title: string; version: string }): Promise<unknown> {
    const result = await this.request("initialize", { clientInfo });
    this.notify("initialized", {});
    return result;
  }

  request<T = unknown>(method: string, params: unknown): Promise<T> {
    const process = this.#requireProcess();
    const id = this.#nextId++;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, this.options.requestTimeoutMs);

      this.#pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer
      });
      process.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    });
  }

  notify(method: string, params: unknown): void {
    this.#requireProcess().stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  respond(id: number | string, result?: unknown, error?: RpcErrorShape): void {
    const message = error ? { id, error } : { id, result };
    this.#requireProcess().stdin.write(`${JSON.stringify(message)}\n`);
  }

  async stop(): Promise<void> {
    const child = this.#process;
    if (!child) return;
    child.kill("SIGTERM");
    this.#process = undefined;
  }

  #requireProcess(): ChildProcessWithoutNullStreams {
    if (!this.#process) throw new Error("Codex app-server is not running");
    return this.#process;
  }

  #handleLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch (error) {
      this.emit("protocolError", new Error(`Invalid JSON from Codex: ${line}`, { cause: error }));
      return;
    }

    const id = message.id;
    if ((typeof id === "number" || typeof id === "string") && ("result" in message || "error" in message)) {
      if (typeof id === "number") {
        const pending = this.#pending.get(id);
        if (pending) {
          clearTimeout(pending.timer);
          this.#pending.delete(id);
          if (message.error) {
            const rpcError = message.error as RpcErrorShape;
            pending.reject(new Error(`Codex RPC ${rpcError.code}: ${rpcError.message}`));
          } else {
            pending.resolve(message.result);
          }
          return;
        }
      }
    }

    if ((typeof id === "number" || typeof id === "string") && typeof message.method === "string") {
      this.emit("serverRequest", message);
      return;
    }

    if (typeof message.method === "string") {
      this.emit("notification", message);
      this.emit(`notification:${message.method}`, message.params);
      return;
    }

    this.emit("unhandled", message);
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
