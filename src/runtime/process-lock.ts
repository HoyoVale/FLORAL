import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

interface StoredProcessLock {
  pid: number;
  instanceId: string;
  createdAt: string;
}

export interface ProcessLockOptions {
  pid?: number;
  now?: (() => Date) | undefined;
  isProcessAlive?: ((pid: number) => boolean) | undefined;
}

export interface ProcessLock {
  path: string;
  pid: number;
  instanceId: string;
  release(): Promise<void>;
}

export class ProcessAlreadyRunningError extends Error {
  readonly pid: number;

  constructor(pid: number) {
    super(`Another FLORAL process is already running with pid ${pid}`);
    this.name = "ProcessAlreadyRunningError";
    this.pid = pid;
  }
}

export async function acquireProcessLock(
  lockPath: string,
  options: ProcessLockOptions = {},
): Promise<ProcessLock> {
  const resolvedPath = resolve(lockPath);
  const pid = options.pid ?? process.pid;
  const now = options.now ?? (() => new Date());
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const instanceId = randomBytes(16).toString("hex");

  await mkdir(dirname(resolvedPath), { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const handle = await open(resolvedPath, "wx", 0o600);
      try {
        const stored: StoredProcessLock = {
          pid,
          instanceId,
          createdAt: now().toISOString(),
        };
        await handle.writeFile(`${JSON.stringify(stored)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }

      let released = false;
      return {
        path: resolvedPath,
        pid,
        instanceId,
        release: async () => {
          if (released) return;
          released = true;
          const current = await readStoredLock(resolvedPath);
          if (current?.instanceId !== instanceId || current.pid !== pid) return;
          await rm(resolvedPath, { force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const existing = await readStoredLock(resolvedPath);
    if (existing && isProcessAlive(existing.pid)) {
      throw new ProcessAlreadyRunningError(existing.pid);
    }
    await rm(resolvedPath, { force: true });
  }

  throw new Error("Unable to acquire FLORAL process lock after stale-lock recovery");
}

async function readStoredLock(path: string): Promise<StoredProcessLock | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<StoredProcessLock>;
    if (
      !Number.isInteger(parsed.pid)
      || Number(parsed.pid) <= 0
      || typeof parsed.instanceId !== "string"
      || !parsed.instanceId
      || typeof parsed.createdAt !== "string"
    ) {
      return undefined;
    }
    return {
      pid: Number(parsed.pid),
      instanceId: parsed.instanceId,
      createdAt: parsed.createdAt,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}

function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    return true;
  }
}
