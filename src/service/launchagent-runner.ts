import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { RotatingLogWriter } from "./rotating-log-writer.js";

interface RunnerOptions {
  project: string;
  node: string;
  entry: string;
  stdout: string;
  stderr: string;
  maxLogBytes: number;
  logBackups: number;
  shutdownTimeoutMs: number;
}

const options = parseArguments(process.argv.slice(2));
const stdout = new RotatingLogWriter(
  options.stdout,
  options.maxLogBytes,
  options.logBackups,
);
const stderr = new RotatingLogWriter(
  options.stderr,
  options.maxLogBytes,
  options.logBackups,
);

let child: ChildProcessByStdio<null, Readable, Readable> | undefined;
let stopping = false;
let forcedTimer: ReturnType<typeof setTimeout> | undefined;

try {
  child = spawn(options.node, [options.entry], {
    cwd: options.project,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk: Buffer) => {
    void stdout.write(chunk).catch(() => undefined);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    void stderr.write(chunk).catch(() => undefined);
  });

  const requestStop = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    void stderr.write(`service.runner.signal=${signal}\n`).catch(() => undefined);
    child?.kill("SIGTERM");
    forcedTimer = setTimeout(() => {
      child?.kill("SIGKILL");
    }, options.shutdownTimeoutMs);
    forcedTimer.unref();
  };

  process.once("SIGTERM", () => requestStop("SIGTERM"));
  process.once("SIGINT", () => requestStop("SIGINT"));
  process.once("SIGHUP", () => requestStop("SIGHUP"));

  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolvePromise, reject) => {
      child!.once("error", reject);
      child!.once("exit", (code, signal) => resolvePromise({ code, signal }));
    },
  );

  if (forcedTimer) clearTimeout(forcedTimer);
  await Promise.allSettled([stdout.close(), stderr.close()]);

  if (stopping) {
    process.exitCode = 0;
  } else if (result.code !== null) {
    process.exitCode = result.code === 0 ? 1 : result.code;
  } else {
    process.exitCode = 1;
  }
} catch (error) {
  if (forcedTimer) clearTimeout(forcedTimer);
  await stderr.write(
    `service.runner.error=${error instanceof Error ? error.name : "Error"}\n`,
  ).catch(() => undefined);
  await Promise.allSettled([stdout.close(), stderr.close()]);
  process.exitCode = 1;
}

function parseArguments(args: string[]): RunnerOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error("Invalid LaunchAgent runner arguments");
    }
    values.set(key.slice(2), value);
  }

  return {
    project: required(values, "project"),
    node: required(values, "node"),
    entry: required(values, "entry"),
    stdout: required(values, "stdout"),
    stderr: required(values, "stderr"),
    maxLogBytes: positiveInteger(required(values, "max-log-bytes"), "max-log-bytes"),
    logBackups: boundedInteger(required(values, "log-backups"), "log-backups", 1, 20),
    shutdownTimeoutMs: boundedInteger(
      required(values, "shutdown-timeout-ms"),
      "shutdown-timeout-ms",
      1_000,
      120_000,
    ),
  };
}

function required(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

function positiveInteger(value: string, name: string): number {
  return boundedInteger(value, name, 1, Number.MAX_SAFE_INTEGER);
}

function boundedInteger(value: string, name: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid --${name}`);
  }
  return parsed;
}
