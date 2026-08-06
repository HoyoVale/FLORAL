import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildServicePath,
  renderLaunchAgentPlist,
} from "../src/service/launchagent-config.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("LaunchAgent configuration", () => {
  it("uses the compiled dist/src entry and no credentials", () => {
    const plist = renderLaunchAgentPlist({
      projectDir: "/Volumes/WORK & DATA/FLORAL",
      nodePath: "/opt/homebrew/bin/node",
      runnerPath: "/repo/dist/src/service/launchagent-runner.js",
      entryPath: "/repo/dist/src/main.js",
      pathValue: "/opt/homebrew/bin:/usr/bin:/bin",
      homeDir: "/Users/test",
      tempDir: "/tmp",
      lockPath: "/repo/data/floral.lock",
      statePath: "/repo/data/service-state.json",
      stdoutPath: "/repo/logs/service.out.log",
      stderrPath: "/repo/logs/service.err.log",
      supervisorStdoutPath: "/repo/logs/supervisor.out.log",
      supervisorStderrPath: "/repo/logs/supervisor.err.log",
      logMaxBytes: 1024,
      logBackups: 2,
      shutdownTimeoutMs: 5000,
    });
    expect(plist).toContain("/repo/dist/src/main.js");
    expect(plist).toContain("WORK &amp; DATA");
    expect(plist).toContain("<key>Umask</key>");
    expect(plist).toContain("<integer>63</integer>");
    expect(plist).not.toContain("APP_SECRET");
    expect(plist).not.toContain("DEEPSEEK_API_KEY");
  });

  it("keeps crash-only restart semantics", () => {
    const plist = renderLaunchAgentPlist({
      projectDir: "/repo",
      nodePath: "/node",
      runnerPath: "/runner",
      entryPath: "/entry",
      pathValue: "/bin",
      homeDir: "/home",
      tempDir: "/tmp",
      lockPath: "/lock",
      statePath: "/state",
      stdoutPath: "/out",
      stderrPath: "/err",
      supervisorStdoutPath: "/sout",
      supervisorStderrPath: "/serr",
      logMaxBytes: 1024,
      logBackups: 1,
      shutdownTimeoutMs: 1000,
    });
    expect(plist).toContain("<key>SuccessfulExit</key>");
    expect(plist).toContain("<false/>");
    expect(plist).toContain("<key>ThrottleInterval</key>");
  });

  it("builds a bounded executable path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "floral-path-"));
    directories.push(directory);
    const executable = join(directory, "codex");
    await writeFile(executable, "#!/bin/sh\n");
    if (process.platform !== "win32") await chmod(executable, 0o700);
    const value = await buildServicePath(
      process.platform === "win32" ? [] : ["codex"],
      directory,
    );
    expect(value).toContain("/usr/bin");
    if (process.platform !== "win32") expect(value).toContain(directory);
  });
});
