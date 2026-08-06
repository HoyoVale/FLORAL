import { resolve } from "node:path";
import {
  acquireProcessLock,
  ProcessAlreadyRunningError,
  type ProcessLock,
  type ProcessLockOptions,
} from "../runtime/process-lock.js";

export type ProbeStackGuard = ProcessLock;

export class ProbeStackBusyError extends Error {
  readonly pid: number;

  constructor(pid: number) {
    super(
      `FLORAL stack lock is already held by pid ${pid}; `
      + "stop the LaunchAgent service and any other real probe before retrying",
    );
    this.name = "ProbeStackBusyError";
    this.pid = pid;
  }
}

export async function acquireProbeStackGuard(
  lockPath: string,
  options: ProcessLockOptions = {},
): Promise<ProbeStackGuard> {
  try {
    return await acquireProcessLock(resolve(lockPath), options);
  } catch (error) {
    if (error instanceof ProcessAlreadyRunningError) {
      throw new ProbeStackBusyError(error.pid);
    }
    throw error;
  }
}
