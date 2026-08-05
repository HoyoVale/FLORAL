import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import {
  CodexRuntimeError,
  classifyCodexFailure,
  codexProcessExit,
  codexProtocolError,
  codexRequestTimeout,
} from "./codex-errors.js";

export interface RpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

export interface CodexServerRequest {
  id: number | string;
  method: string;
  params: unknown;
}

export interface CodexExitEvent {
  code: number | null;
  signal: NodeJS.Signals | null;
  error: CodexRuntimeError;
  expected: boolean;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

export interface CodexRpcClientOptions {
  command: string;
  args: string[];
  cwd?: string | undefined;
  requestTimeoutMs: number;
  env?: NodeJS.ProcessEnv | undefined;
}

export class CodexRpcClient extends EventEmitter {
  #process: ChildProcessWithoutNullStreams | undefined;
  #stdoutLines: ReadlineInterface | undefined;
  #nextId = 1;
  #stopping = false;
  #exitPromise: Promise<void> | undefined;
  #resolveExit: (() => void) | undefined;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #stderrLines: string[] = [];

  constructor(private readonly options: CodexRpcClientOptions) {
    super();
  }

  get isRunning(): boolean {
    return this.#process !== undefined;
  }

  async start(): Promise<void> {
    if (this.#process) return;

    this.#stopping = false;
    this.#stderrLines.length = 0;

    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: this.options.env ?? process.env,
      windowsHide: true,
    });
    this.#process = child;
    this.#exitPromise = new Promise<void>((resolve) => {
      this.#resolveExit = resolve;
    });

    this.#stdoutLines = createInterface({ input: child.stdout });
    this.#stdoutLines.on("line", (line) => this.#handleLine(line));
    child.stderr.on("data", (chunk: Buffer | string) => this.#handleStderr(String(chunk)));
    child.on("error", (error) => {
      const wrapped = new CodexRuntimeError({
        kind: "process_exit",
        message: `Failed to start or communicate with Codex app-server: ${error.message}`,
        retryable: true,
        cause: error,
      });
      this.#failAll(wrapped);
      this.emit("processError", wrapped);
    });
    child.on("close", (code, signal) => this.#handleExit(child, code, signal));

    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        child.off("error", onInitialError);
        resolve();
      };
      const onInitialError = (error: Error) => {
        child.off("spawn", onSpawn);
        reject(new CodexRuntimeError({
          kind: "process_exit",
          message: `Unable to spawn Codex app-server: ${error.message}`,
          retryable: true,
          cause: error,
        }));
      };
      child.once("spawn", onSpawn);
      child.once("error", onInitialError);
    });
  }

  async initialize(clientInfo: { name: string; title: string; version: string }): Promise<unknown> {
    const result = await this.request("initialize", { clientInfo });
    this.notify("initialized", {});
    return result;
  }

  request<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    const child = this.#requireProcess();
    const id = this.#nextId++;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(codexRequestTimeout(method, this.options.requestTimeoutMs));
      }, this.options.requestTimeoutMs);

      this.#pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });

      try {
        child.stdin.write(`${JSON.stringify({ method, id, params })}\n`, (error) => {
          if (!error) return;
          const pending = this.#pending.get(id);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.#pending.delete(id);
          pending.reject(new CodexRuntimeError({
            kind: "process_exit",
            message: `Failed to write Codex request ${method}: ${error.message}`,
            retryable: true,
            method,
            cause: error,
          }));
        });
      } catch (error) {
        const pending = this.#pending.get(id);
        if (pending) {
          clearTimeout(pending.timer);
          this.#pending.delete(id);
        }
        reject(new CodexRuntimeError({
          kind: "process_exit",
          message: `Failed to write Codex request ${method}`,
          retryable: true,
          method,
          cause: error,
        }));
      }
    });
  }

  notify(method: string, params: unknown = {}): void {
    const child = this.#requireProcess();
    try {
      child.stdin.write(`${JSON.stringify({ method, params })}\n`);
    } catch (error) {
      throw new CodexRuntimeError({
        kind: "process_exit",
        message: `Failed to write Codex notification ${method}`,
        retryable: true,
        method,
        cause: error,
      });
    }
  }

  respond(id: number | string, result?: unknown, error?: RpcErrorShape): void {
    const message = error === undefined ? { id, result: result ?? {} } : { id, error };
    this.#requireProcess().stdin.write(`${JSON.stringify(message)}\n`);
  }

  async stop(graceMs = 2_000): Promise<void> {
    const child = this.#process;
    if (!child) return;

    this.#stopping = true;
    child.kill("SIGTERM");
    await Promise.race([
      this.#exitPromise ?? Promise.resolve(),
      delay(graceMs),
    ]);

    if (this.#process === child) {
      child.kill("SIGKILL");
      await Promise.race([
        this.#exitPromise ?? Promise.resolve(),
        delay(500),
      ]);
    }
  }

  #requireProcess(): ChildProcessWithoutNullStreams {
    if (!this.#process) {
      throw new CodexRuntimeError({
        kind: "process_exit",
        message: "Codex app-server is not running",
        retryable: true,
      });
    }
    return this.#process;
  }

  #handleLine(line: string): void {
    if (line.trim().length === 0) return;

    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch (error) {
      const protocolError = codexProtocolError(`Invalid JSON from Codex app-server: ${line}`, error);
      this.emit("protocolError", protocolError);
      return;
    }

    const id = message.id;
    if (typeof id === "number" && ("result" in message || "error" in message)) {
      const pending = this.#pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.#pending.delete(id);
        if (message.error !== undefined) {
          const rpcError = message.error as RpcErrorShape;
          const wrapped = classifyCodexFailure(
            {
              message: `Codex RPC ${rpcError.code}: ${rpcError.message}`,
              ...(rpcError.data === undefined ? {} : { error: rpcError.data }),
            },
            { method: pending.method, code: rpcError.code },
          );
          pending.reject(wrapped.kind === "unknown"
            ? new CodexRuntimeError({
                kind: "protocol",
                message: wrapped.message,
                retryable: rpcError.code === -32001,
                method: pending.method,
                code: rpcError.code,
                data: rpcError.data,
              })
            : wrapped);
        } else {
          pending.resolve(message.result);
        }
        return;
      }
    }

    if ((typeof id === "number" || typeof id === "string") && typeof message.method === "string") {
      const request: CodexServerRequest = {
        id,
        method: message.method,
        params: message.params,
      };
      this.emit("serverRequest", request);
      return;
    }

    if (typeof message.method === "string") {
      this.emit("notification", message);
      this.emit(`notification:${message.method}`, message.params);
      return;
    }

    this.emit("unhandled", message);
  }

  #handleStderr(chunk: string): void {
    this.emit("stderr", chunk);
    for (const line of chunk.split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      this.#stderrLines.push(line);
      if (this.#stderrLines.length > 20) this.#stderrLines.shift();
    }
  }

  #handleExit(
    child: ChildProcessWithoutNullStreams,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.#process !== child) return;

    const error = codexProcessExit(code, signal, this.#stderrLines.join("\n"));
    const expected = this.#stopping;
    this.#stdoutLines?.close();
    this.#stdoutLines = undefined;
    this.#process = undefined;
    this.#failAll(error);
    this.#resolveExit?.();
    this.#resolveExit = undefined;
    this.#exitPromise = undefined;
    this.emit("exit", { code, signal, error, expected } satisfies CodexExitEvent);
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
