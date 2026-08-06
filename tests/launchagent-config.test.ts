import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildServicePath,
  renderLaunchAgentPlist,
  summarizeLaunchctlPrint,
} from "../src/service/launchagent-config.js";
import {
  prepareLaunchAgentUserPaths,
  resolveLaunchAgentUserPaths,
} from "../src/service/launchagent-paths.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("LaunchAgent configuration", () => {
  it("uses the compiled dist/src entry and no credentials", () => {
    const plist = renderLaunchAgentPlist({
      projectDir: "/Volumes/WORK & DATA/FLORAL",
      workingDirectory: "/Users/test/Library/Application Support/FLORAL/runtime",
      nodePath: "/opt/homebrew/bin/node",
      runnerPath: "/repo/dist/src/service/launchagent-runner.js",
      entryPath: "/repo/dist/src/main.js",
      pathValue: "/opt/homebrew/bin:/usr/bin:/bin",
      homeDir: "/Users/test",
      tempDir: "/tmp",
      lockPath: "/repo/data/floral.lock",
      statePath: "/repo/data/service-state.json",
      stdoutPath: "/Users/test/Library/Logs/FLORAL/service.out.log",
      stderrPath: "/Users/test/Library/Logs/FLORAL/service.err.log",
      supervisorStdoutPath:
        "/Users/test/Library/Logs/FLORAL/launchagent.supervisor.out.log",
      supervisorStderrPath:
        "/Users/test/Library/Logs/FLORAL/launchagent.supervisor.err.log",
      logMaxBytes: 1024,
      logBackups: 2,
      shutdownTimeoutMs: 5000,
    });
    expect(plist).toContain("/repo/dist/src/main.js");
    expect(plist).toContain("WORK &amp; DATA");
    expect(plist).toContain("Application Support/FLORAL/runtime");
    expect(plist).toContain("Library/Logs/FLORAL/service.err.log");
    expect(plist).toContain("<key>Umask</key>");
    expect(plist).toContain("<integer>63</integer>");
    expect(plist).not.toContain("APP_SECRET");
    expect(plist).not.toContain("DEEPSEEK_API_KEY");
  });

  it("keeps launchd-owned paths off an external project volume", () => {
    const userPaths = resolveLaunchAgentUserPaths("/Users/test");
    const projectDir = "/Volumes/WORK_1TB/FLORAL";
    const plist = renderLaunchAgentPlist({
      projectDir,
      workingDirectory: userPaths.runtimeDir,
      nodePath: "/node",
      runnerPath: `${projectDir}/dist/src/service/launchagent-runner.js`,
      entryPath: `${projectDir}/dist/src/main.js`,
      pathValue: "/bin",
      homeDir: "/Users/test",
      tempDir: "/tmp",
      lockPath: `${projectDir}/data/floral.lock`,
      statePath: `${projectDir}/data/service-state.json`,
      stdoutPath: userPaths.stdout,
      stderrPath: userPaths.stderr,
      supervisorStdoutPath: userPaths.supervisorStdout,
      supervisorStderrPath: userPaths.supervisorStderr,
      logMaxBytes: 1024,
      logBackups: 1,
      shutdownTimeoutMs: 1000,
    });

    const workingDirectoryBlock = plist.match(
      /<key>WorkingDirectory<\/key>\s*<string>(.*?)<\/string>/u,
    );
    expect(workingDirectoryBlock?.[1]).toBe(userPaths.runtimeDir);
    expect(workingDirectoryBlock?.[1]).not.toContain("/Volumes/");
    expect(plist).toContain(projectDir);
    expect(plist).toContain(userPaths.supervisorStdout);
    expect(plist).toContain(userPaths.supervisorStderr);
    expect(userPaths.stdout).not.toContain(projectDir);
    expect(userPaths.stderr).not.toContain(projectDir);
  });

  it("prepares private internal runtime and log paths", async () => {
    const home = await mkdtemp(join(tmpdir(), "floral-launchagent-home-"));
    directories.push(home);
    const paths = resolveLaunchAgentUserPaths(home);

    await prepareLaunchAgentUserPaths(paths);

    expect((await stat(paths.runtimeDir)).isDirectory()).toBe(true);
    expect((await stat(paths.logDir)).isDirectory()).toBe(true);
    for (const path of [
      paths.stdout,
      paths.stderr,
      paths.supervisorStdout,
      paths.supervisorStderr,
    ]) {
      expect((await stat(path)).isFile()).toBe(true);
      expect(await readFile(path, "utf8")).toBe("");
    }

    if (process.platform !== "win32") {
      expect((await stat(paths.runtimeDir)).mode & 0o777).toBe(0o700);
      expect((await stat(paths.logDir)).mode & 0o777).toBe(0o700);
      expect((await stat(paths.stderr)).mode & 0o777).toBe(0o600);
      expect((await stat(paths.supervisorStderr)).mode & 0o777).toBe(0o600);
    }
  });

  it("keeps crash-only restart semantics", () => {
    const plist = renderLaunchAgentPlist({
      projectDir: "/repo",
      workingDirectory: "/runtime",
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

  it("summarizes launchctl failures for ready-timeout diagnostics", () => {
    const summary = summarizeLaunchctlPrint(`
      path = /Users/test/Library/LaunchAgents/com.hoyo.mac-agent.plist
      state = spawn scheduled
      program = /opt/homebrew/bin/node
      working directory = /Users/test/Library/Application Support/FLORAL/runtime
      runs = 54
      last exit code = 78: EX_CONFIG
      unrelated = omitted
    `);
    expect(summary).toContain("state = spawn scheduled");
    expect(summary).toContain("last exit code = 78: EX_CONFIG");
    expect(summary).not.toContain("unrelated = omitted");
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
