import { delimiter, dirname, isAbsolute, resolve } from "node:path";
import { access, constants } from "node:fs/promises";

export const FLORAL_LAUNCH_AGENT_LABEL = "com.hoyo.mac-agent";

export interface LaunchAgentPlistOptions {
  projectDir: string;
  workingDirectory: string;
  nodePath: string;
  runnerPath: string;
  entryPath: string;
  pathValue: string;
  homeDir: string;
  tempDir: string;
  lockPath: string;
  statePath: string;
  stdoutPath: string;
  stderrPath: string;
  supervisorStdoutPath: string;
  supervisorStderrPath: string;
  logMaxBytes: number;
  logBackups: number;
  shutdownTimeoutMs: number;
}

export function renderLaunchAgentPlist(options: LaunchAgentPlistOptions): string {
  const argumentsList = [
    options.nodePath,
    options.runnerPath,
    "--project", options.projectDir,
    "--node", options.nodePath,
    "--entry", options.entryPath,
    "--stdout", options.stdoutPath,
    "--stderr", options.stderrPath,
    "--max-log-bytes", String(options.logMaxBytes),
    "--log-backups", String(options.logBackups),
    "--shutdown-timeout-ms", String(options.shutdownTimeoutMs),
  ];

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>${xmlEscape(FLORAL_LAUNCH_AGENT_LABEL)}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    ...argumentsList.map((value) => `    <string>${xmlEscape(value)}</string>`),
    `  </array>`,
    `  <key>WorkingDirectory</key>`,
    `  <string>${xmlEscape(options.workingDirectory)}</string>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    envEntry("NODE_ENV", "production"),
    envEntry("FLORAL_SERVICE_MODE", "launchagent"),
    envEntry("FLORAL_INSTANCE_LOCK_PATH", options.lockPath),
    envEntry("FLORAL_SERVICE_STATE_PATH", options.statePath),
    envEntry("PATH", options.pathValue),
    envEntry("HOME", options.homeDir),
    envEntry("TMPDIR", options.tempDir),
    `  </dict>`,
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    `  <key>KeepAlive</key>`,
    `  <dict>`,
    `    <key>SuccessfulExit</key>`,
    `    <false/>`,
    `  </dict>`,
    `  <key>ThrottleInterval</key>`,
    `  <integer>15</integer>`,
    `  <key>ProcessType</key>`,
    `  <string>Background</string>`,
    `  <key>ExitTimeOut</key>`,
    `  <integer>30</integer>`,
    `  <key>Umask</key>`,
    `  <integer>63</integer>`,
    `  <key>StandardOutPath</key>`,
    `  <string>${xmlEscape(options.supervisorStdoutPath)}</string>`,
    `  <key>StandardErrorPath</key>`,
    `  <string>${xmlEscape(options.supervisorStderrPath)}</string>`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
}

export async function buildServicePath(
  commands: string[],
  sourcePath = process.env.PATH ?? "",
): Promise<string> {
  const directories = new Set<string>([
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ]);

  for (const command of commands) {
    const executable = await resolveExecutable(command, sourcePath);
    directories.add(dirname(executable));
  }

  return [...directories].join(":");
}

export async function resolveExecutable(
  command: string,
  pathValue = process.env.PATH ?? "",
): Promise<string> {
  if (!command.trim()) throw new Error("Executable command must not be empty");

  const candidates = command.includes("/") || isAbsolute(command)
    ? [resolve(command)]
    : pathValue.split(delimiter).filter(Boolean).map((directory) => resolve(directory, command));

  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching.
    }
  }
  throw new Error(`Required executable not found: ${command}`);
}

export function summarizeLaunchctlPrint(value: string): string {
  if (!value.trim()) return "(no launchctl output)";
  const relevant = value
    .split(/\r?\n/u)
    .filter((line) =>
      /state =|pid =|runs =|last exit code|reason =|program =|working directory|stdout path|stderr path/iu
        .test(line),
    );
  return relevant.length > 0 ? relevant.join("\n") : value.slice(-16 * 1024);
}

function envEntry(key: string, value: string): string {
  return [
    `    <key>${xmlEscape(key)}</key>`,
    `    <string>${xmlEscape(value)}</string>`,
  ].join("\n");
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
