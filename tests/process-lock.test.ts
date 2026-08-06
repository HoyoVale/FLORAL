import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireProcessLock,
  ProcessAlreadyRunningError,
} from "../src/runtime/process-lock.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("process lock", () => {
  it("creates and releases an atomic owner lock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "floral-lock-"));
    directories.push(directory);
    const path = join(directory, "floral.lock");
    const lock = await acquireProcessLock(path, { pid: 1234, isProcessAlive: () => false });
    const stored = JSON.parse(await readFile(path, "utf8")) as { pid: number };
    expect(stored.pid).toBe(1234);
    await lock.release();
    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a live recorded process", async () => {
    const directory = await mkdtemp(join(tmpdir(), "floral-lock-"));
    directories.push(directory);
    const path = join(directory, "floral.lock");
    await writeFile(path, JSON.stringify({
      pid: 777,
      instanceId: "existing",
      createdAt: new Date().toISOString(),
    }));
    await expect(acquireProcessLock(path, {
      pid: 888,
      isProcessAlive: (pid) => pid === 777,
    })).rejects.toBeInstanceOf(ProcessAlreadyRunningError);
  });

  it("replaces a stale recorded process", async () => {
    const directory = await mkdtemp(join(tmpdir(), "floral-lock-"));
    directories.push(directory);
    const path = join(directory, "floral.lock");
    await writeFile(path, JSON.stringify({
      pid: 777,
      instanceId: "stale",
      createdAt: new Date().toISOString(),
    }));
    const lock = await acquireProcessLock(path, {
      pid: 888,
      isProcessAlive: () => false,
    });
    const stored = JSON.parse(await readFile(path, "utf8")) as { pid: number };
    expect(stored.pid).toBe(888);
    await lock.release();
  });

  it("does not remove a lock replaced by another instance", async () => {
    const directory = await mkdtemp(join(tmpdir(), "floral-lock-"));
    directories.push(directory);
    const path = join(directory, "floral.lock");
    const lock = await acquireProcessLock(path, { pid: 1234, isProcessAlive: () => false });
    await writeFile(path, JSON.stringify({
      pid: 9999,
      instanceId: "replacement",
      createdAt: new Date().toISOString(),
    }));
    await lock.release();
    expect(await readFile(path, "utf8")).toContain("replacement");
  });
});
