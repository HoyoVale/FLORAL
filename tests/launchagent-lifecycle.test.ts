import { describe, expect, it } from "vitest";
import { waitForLaunchAgentShutdown } from "../src/service/launchagent-lifecycle.js";

describe("LaunchAgent lifecycle", () => {
  it("waits for both launchd unload and the previous process exit", async () => {
    const loaded = [true, false, false];
    const alive = [true, true, false];
    let now = 0;
    let probes = 0;

    await waitForLaunchAgentShutdown({
      previousPid: 123,
      timeoutMs: 10_000,
      pollIntervalMs: 10,
      isLoaded: async () => loaded[Math.min(probes, loaded.length - 1)]!,
      isProcessAlive: () => alive[Math.min(probes++, alive.length - 1)]!,
      sleep: async (ms) => {
        now += ms;
      },
      now: () => now,
    });

    expect(probes).toBe(3);
  });

  it("does not treat an unloaded job as stopped while its child is alive", async () => {
    const alive = [true, true, false];
    let now = 0;
    let probes = 0;

    await waitForLaunchAgentShutdown({
      previousPid: 456,
      timeoutMs: 10_000,
      pollIntervalMs: 10,
      isLoaded: async () => false,
      isProcessAlive: () => alive[Math.min(probes++, alive.length - 1)]!,
      sleep: async (ms) => {
        now += ms;
      },
      now: () => now,
    });

    expect(probes).toBe(3);
  });

  it("reports the remaining launchd and process state on timeout", async () => {
    let now = 0;

    await expect(
      waitForLaunchAgentShutdown({
        previousPid: 789,
        timeoutMs: 20,
        pollIntervalMs: 10,
        isLoaded: async () => true,
        isProcessAlive: () => true,
        sleep: async (ms) => {
          now += ms;
        },
        now: () => now,
      }),
    ).rejects.toThrow(
      "loaded=true, previous_pid=789, previous_pid_alive=true",
    );
  });
});
