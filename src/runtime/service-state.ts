import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type ServicePhase = "starting" | "ready" | "stopping" | "stopped" | "failed";

export interface ServiceState {
  schemaVersion: 1;
  phase: ServicePhase;
  pid: number;
  instanceId: string;
  startedAt: string;
  updatedAt: string;
  errorType?: string | undefined;
}

export interface ServiceStateWriter {
  path: string;
  write(phase: ServicePhase, errorType?: string): Promise<void>;
}

export function createServiceStateWriter(
  statePath: string,
  options: {
    pid: number;
    instanceId: string;
    now?: (() => Date) | undefined;
  },
): ServiceStateWriter {
  const resolvedPath = resolve(statePath);
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();

  return {
    path: resolvedPath,
    write: async (phase, errorType) => {
      const timestamp = now().toISOString();
      const state: ServiceState = {
        schemaVersion: 1,
        phase,
        pid: options.pid,
        instanceId: options.instanceId,
        startedAt,
        updatedAt: timestamp,
        ...(errorType ? { errorType } : {}),
      };
      await writeServiceState(resolvedPath, state);
    },
  };
}

export async function readServiceState(
  statePath: string,
): Promise<ServiceState | undefined> {
  try {
    const parsed = JSON.parse(await readFile(resolve(statePath), "utf8")) as Partial<ServiceState>;
    if (
      parsed.schemaVersion !== 1
      || !isPhase(parsed.phase)
      || !Number.isInteger(parsed.pid)
      || Number(parsed.pid) <= 0
      || typeof parsed.instanceId !== "string"
      || typeof parsed.startedAt !== "string"
      || typeof parsed.updatedAt !== "string"
    ) {
      return undefined;
    }
    return {
      schemaVersion: 1,
      phase: parsed.phase,
      pid: Number(parsed.pid),
      instanceId: parsed.instanceId,
      startedAt: parsed.startedAt,
      updatedAt: parsed.updatedAt,
      ...(typeof parsed.errorType === "string" ? { errorType: parsed.errorType } : {}),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}

async function writeServiceState(path: string, state: ServiceState): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function isPhase(value: unknown): value is ServicePhase {
  return value === "starting"
    || value === "ready"
    || value === "stopping"
    || value === "stopped"
    || value === "failed";
}
