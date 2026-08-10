import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { readServiceState } from "../runtime/service-state.js";
import { FLORAL_LAUNCH_AGENT_LABEL } from "../service/launchagent-config.js";
import {
  readSystemMaintenanceTransaction,
  writeSystemMaintenanceTransaction,
} from "./system-maintenance.js";

const args = readArgs(process.argv.slice(2));
const directory = resolve(required(args, "directory"));
const transactionId = required(args, "transaction");
const serviceStatePath = resolve(required(args, "service-state"));

if (process.platform !== "darwin") throw new Error("Service restart worker requires macOS");
const transaction = await readSystemMaintenanceTransaction(directory, transactionId);
if (!transaction || transaction.componentId !== "floral.service" || transaction.actionId !== "restart") {
  throw new Error("Invalid service restart transaction");
}

const running = {
  ...transaction,
  status: "running" as const,
  updatedAt: new Date().toISOString(),
};
await writeSystemMaintenanceTransaction(directory, running);

try {
  // Give the initiating Gateway enough time to deliver the Agent's final reply
  // and unwind the current request before launchd replaces the service process.
  await delay(1_500);
  const uid = process.getuid?.();
  if (!Number.isInteger(uid) || Number(uid) < 0) throw new Error("Unable to resolve macOS uid");
  const target = `gui/${String(uid)}/${FLORAL_LAUNCH_AGENT_LABEL}`;
  const result = await runLaunchctl(["kickstart", "-k", target]);
  if (result !== 0) throw new Error("LaunchctlRestartFailed");

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const state = await readServiceState(serviceStatePath);
    if (
      state?.phase === "ready"
      && state.pid !== transaction.previousPid
      && isProcessAlive(state.pid)
    ) {
      await writeSystemMaintenanceTransaction(directory, {
        ...running,
        status: "verified",
        updatedAt: new Date().toISOString(),
        resultingPid: state.pid,
        verification: "service-ready-new-pid",
      });
      process.exitCode = 0;
      break;
    }
    await delay(750);
  }

  const latest = await readSystemMaintenanceTransaction(directory, transactionId);
  if (latest?.status !== "verified") throw new Error("ServiceRestartVerificationTimeout");
} catch (error) {
  await writeSystemMaintenanceTransaction(directory, {
    ...running,
    status: "failed",
    updatedAt: new Date().toISOString(),
    errorType: safeErrorType(error),
  }).catch(() => undefined);
  process.exitCode = 1;
}

function readArgs(values: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error("Invalid worker arguments");
    result.set(key.slice(2), value);
  }
  return result;
}

function required(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

async function runLaunchctl(args: string[]): Promise<number> {
  return await new Promise<number>((resolvePromise, reject) => {
    const child = spawn("/bin/launchctl", args, { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => resolvePromise(code ?? 1));
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function safeErrorType(error: unknown): string {
  const name = error instanceof Error ? error.name : "Error";
  return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(name) ? name : "Error";
}
