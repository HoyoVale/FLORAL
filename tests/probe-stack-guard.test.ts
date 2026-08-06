import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireProbeStackGuard,
  ProbeStackBusyError,
} from "../src/service/probe-stack-guard.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("real probe stack guard", () => {
  it("blocks a second production stack while the shared lock owner is alive", async () => {
    const directory = await mkdtemp(join(tmpdir(), "floral-probe-guard-"));
    directories.push(directory);
    const path = join(directory, "floral.lock");
    const first = await acquireProbeStackGuard(path, {
      pid: 101,
      isProcessAlive: () => false,
    });

    await expect(
      acquireProbeStackGuard(path, {
        pid: 202,
        isProcessAlive: (pid) => pid === 101,
      }),
    ).rejects.toMatchObject({
      name: "ProbeStackBusyError",
      pid: 101,
    } satisfies Partial<ProbeStackBusyError>);

    await first.release();
  });

  it("releases the shared lock so the service or a later probe can start", async () => {
    const directory = await mkdtemp(join(tmpdir(), "floral-probe-guard-"));
    directories.push(directory);
    const path = join(directory, "floral.lock");
    const first = await acquireProbeStackGuard(path, {
      pid: 303,
      isProcessAlive: () => false,
    });
    await first.release();

    const second = await acquireProbeStackGuard(path, {
      pid: 404,
      isProcessAlive: () => false,
    });
    await second.release();
  });
});
