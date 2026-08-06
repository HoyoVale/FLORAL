export interface WaitForLaunchAgentShutdownOptions {
  previousPid: number | undefined;
  timeoutMs: number;
  pollIntervalMs?: number | undefined;
  isLoaded: () => Promise<boolean>;
  isProcessAlive: (pid: number) => boolean;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  now?: (() => number) | undefined;
}

export async function waitForLaunchAgentShutdown(
  options: WaitForLaunchAgentShutdownOptions,
): Promise<void> {
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const sleep = options.sleep ?? delay;
  const now = options.now ?? Date.now;
  const deadline = now() + options.timeoutMs;

  while (true) {
    const loaded = await options.isLoaded();
    const previousPidAlive = options.previousPid !== undefined
      && options.isProcessAlive(options.previousPid);

    if (!loaded && !previousPidAlive) return;

    if (now() >= deadline) {
      throw new Error(
        "LaunchAgent did not fully stop before timeout "
        + `(loaded=${String(loaded)}, previous_pid=${options.previousPid ?? "none"}, `
        + `previous_pid_alive=${String(previousPidAlive)})`,
      );
    }

    await sleep(pollIntervalMs);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
