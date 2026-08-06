import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createServiceStateWriter,
  readServiceState,
} from "../src/runtime/service-state.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("service state", () => {
  it("writes bounded ready metadata atomically", async () => {
    const directory = await mkdtemp(join(tmpdir(), "floral-state-"));
    directories.push(directory);
    const path = join(directory, "service-state.json");
    const writer = createServiceStateWriter(path, {
      pid: 321,
      instanceId: "instance-a",
      now: () => new Date("2026-08-06T12:00:00.000Z"),
    });
    await writer.write("ready");
    expect(await readServiceState(path)).toMatchObject({
      phase: "ready",
      pid: 321,
      instanceId: "instance-a",
    });
  });

  it("stores only an error class for failed startup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "floral-state-"));
    directories.push(directory);
    const path = join(directory, "service-state.json");
    const writer = createServiceStateWriter(path, {
      pid: 321,
      instanceId: "instance-a",
    });
    await writer.write("failed", "NetworkError");
    const state = await readServiceState(path);
    expect(state?.errorType).toBe("NetworkError");
    expect(JSON.stringify(state)).not.toContain("secret");
  });

  it("uses owner-only file permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "floral-state-"));
    directories.push(directory);
    const path = join(directory, "service-state.json");
    const writer = createServiceStateWriter(path, {
      pid: 321,
      instanceId: "instance-a",
    });
    await writer.write("starting");
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o077).toBe(0);
    }
  });

  it("updates the same state file across lifecycle phases", async () => {
    const directory = await mkdtemp(join(tmpdir(), "floral-state-"));
    directories.push(directory);
    const path = join(directory, "service-state.json");
    const writer = createServiceStateWriter(path, {
      pid: 321,
      instanceId: "instance-a",
    });
    await writer.write("starting");
    await writer.write("ready");
    await writer.write("stopping");
    expect((await readServiceState(path))?.phase).toBe("stopping");
  });
});
