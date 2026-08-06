import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface LaunchAgentUserPaths {
  runtimeDir: string;
  logDir: string;
  stdout: string;
  stderr: string;
  supervisorStdout: string;
  supervisorStderr: string;
}

export function resolveLaunchAgentUserPaths(homeDir: string): LaunchAgentUserPaths {
  const resolvedHome = resolve(homeDir);
  const runtimeDir = join(
    resolvedHome,
    "Library",
    "Application Support",
    "FLORAL",
    "runtime",
  );
  const logDir = join(resolvedHome, "Library", "Logs", "FLORAL");

  return {
    runtimeDir,
    logDir,
    stdout: join(logDir, "service.out.log"),
    stderr: join(logDir, "service.err.log"),
    supervisorStdout: join(logDir, "launchagent.supervisor.out.log"),
    supervisorStderr: join(logDir, "launchagent.supervisor.err.log"),
  };
}

export async function prepareLaunchAgentUserPaths(
  paths: LaunchAgentUserPaths,
): Promise<void> {
  await mkdir(paths.runtimeDir, { recursive: true, mode: 0o700 });
  await mkdir(paths.logDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    await chmod(paths.runtimeDir, 0o700);
    await chmod(paths.logDir, 0o700);
  }

  await Promise.all(
    [
      paths.stdout,
      paths.stderr,
      paths.supervisorStdout,
      paths.supervisorStderr,
    ].map(async (path) => {
      await writeFile(path, "", {
        encoding: "utf8",
        flag: "a",
        mode: 0o600,
      });
      if (process.platform !== "win32") await chmod(path, 0o600);
    }),
  );
}
