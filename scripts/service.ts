import { spawn } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../src/config/env.js";
import { loadProjectEnv } from "../src/config/load-project-env.js";
import { readServiceState } from "../src/runtime/service-state.js";
import {
  buildServicePath,
  FLORAL_LAUNCH_AGENT_LABEL,
  renderLaunchAgentPlist,
  resolveExecutable,
} from "../src/service/launchagent-config.js";
import { checkSearxng } from "../src/search/searxng.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const launchAgentPath = join(
  homedir(),
  "Library",
  "LaunchAgents",
  `${FLORAL_LAUNCH_AGENT_LABEL}.plist`,
);
const serviceTarget = `gui/${String(process.getuid?.() ?? -1)}/${FLORAL_LAUNCH_AGENT_LABEL}`;
const command = process.argv[2] ?? "status";

if (process.platform !== "darwin") {
  throw new Error("FLORAL LaunchAgent commands must run on macOS");
}

loadProjectEnv(join(repositoryRoot, ".env"));
const env = loadEnv(process.env);
const paths = {
  lock: resolve(repositoryRoot, env.FLORAL_INSTANCE_LOCK_PATH),
  state: resolve(repositoryRoot, env.FLORAL_SERVICE_STATE_PATH),
  runner: join(repositoryRoot, "dist", "src", "service", "launchagent-runner.js"),
  entry: join(repositoryRoot, "dist", "src", "main.js"),
  stdout: join(repositoryRoot, "logs", "service.out.log"),
  stderr: join(repositoryRoot, "logs", "service.err.log"),
  supervisorStdout: join(repositoryRoot, "logs", "launchagent.supervisor.out.log"),
  supervisorStderr: join(repositoryRoot, "logs", "launchagent.supervisor.err.log"),
};

switch (command) {
  case "doctor":
    await doctor();
    break;
  case "install":
    await install();
    break;
  case "start":
    await start();
    break;
  case "status":
    await status();
    break;
  case "restart":
    await restart();
    break;
  case "stop":
    await stop();
    break;
  case "logs":
    await logs();
    break;
  case "recovery-probe":
    await recoveryProbe();
    break;
  case "uninstall":
    await uninstall();
    break;
  default:
    throw new Error(`Unknown service command: ${command}`);
}

async function doctor(): Promise<void> {
  await ensureBuild();
  await ensurePrivateEnv();
  const codex = await resolveExecutable(env.CODEX_COMMAND);
  const npx = await resolveExecutable("npx");
  const node = process.execPath;
  await access(node, constants.X_OK);
  const search = await checkSearxng(
    env.SEARXNG_URL,
    env.SEARXNG_REQUEST_TIMEOUT_MS,
  );

  console.log("service.doctor.platform=ok");
  console.log("service.doctor.build=ok");
  console.log("service.doctor.env_permissions=ok");
  console.log(`service.doctor.node=${node}`);
  console.log(`service.doctor.codex=${codex}`);
  console.log(`service.doctor.npx=${npx}`);
  console.log(`service.doctor.searxng_results=${search.resultCount}`);
  console.log("service.doctor=ok");
}

async function install(): Promise<void> {
  await doctor();
  await mkdir(dirname(launchAgentPath), { recursive: true, mode: 0o700 });
  await mkdir(join(repositoryRoot, "logs"), { recursive: true, mode: 0o700 });
  await mkdir(join(repositoryRoot, "data"), { recursive: true, mode: 0o700 });

  const servicePath = await buildServicePath([
    process.execPath,
    env.CODEX_COMMAND,
    "npx",
  ]);
  const plist = renderLaunchAgentPlist({
    projectDir: repositoryRoot,
    nodePath: process.execPath,
    runnerPath: paths.runner,
    entryPath: paths.entry,
    pathValue: servicePath,
    homeDir: homedir(),
    tempDir: tmpdir(),
    lockPath: paths.lock,
    statePath: paths.state,
    stdoutPath: paths.stdout,
    stderrPath: paths.stderr,
    supervisorStdoutPath: paths.supervisorStdout,
    supervisorStderrPath: paths.supervisorStderr,
    logMaxBytes: 5 * 1024 * 1024,
    logBackups: 5,
    shutdownTimeoutMs: 20_000,
  });

  const previous = await readServiceState(paths.state);
  if (await isLoaded()) await bootout();
  await writeFile(launchAgentPath, plist, { encoding: "utf8", mode: 0o600 });
  await chmod(launchAgentPath, 0o600);
  await runExecutable("/usr/bin/plutil", ["-lint", launchAgentPath]);
  await runLaunchctl(["enable", serviceTarget]);
  await runLaunchctl(["bootstrap", domainTarget(), launchAgentPath]);
  await waitForReady(previous?.pid, 120_000);
  console.log(`service.plist=${launchAgentPath}`);
  console.log("service.install=ok");
}

async function start(): Promise<void> {
  await ensureBuild();
  await ensurePrivateEnv();
  if (!(await fileExists(launchAgentPath))) {
    throw new Error("LaunchAgent plist is not installed; run service:install");
  }
  const previous = await readServiceState(paths.state);
  if (!(await isLoaded())) {
    await runLaunchctl(["bootstrap", domainTarget(), launchAgentPath]);
  } else {
    await runLaunchctl(["kickstart", "-k", serviceTarget]);
  }
  await waitForReady(previous?.pid, 120_000);
  console.log("service.start=ok");
}

async function status(): Promise<void> {
  const loaded = await isLoaded();
  const state = await readServiceState(paths.state);
  const pidAlive = state ? isProcessAlive(state.pid) : false;
  console.log(`service.loaded=${loaded}`);
  console.log(`service.state=${state?.phase ?? "unknown"}`);
  console.log(`service.pid=${state?.pid ?? "none"}`);
  console.log(`service.pid_alive=${pidAlive}`);
  console.log(`service.instance=${state?.instanceId ?? "none"}`);
  if (state?.errorType) console.log(`service.error_type=${state.errorType}`);
  console.log(`service.status=${loaded && state?.phase === "ready" && pidAlive ? "ok" : "not_ready"}`);
}

async function restart(): Promise<void> {
  if (await isLoaded()) await bootout();
  await start();
  console.log("service.restart=ok");
}

async function stop(): Promise<void> {
  if (await isLoaded()) await bootout();
  await waitForStopped(30_000);
  console.log("service.stop=ok");
}

async function logs(): Promise<void> {
  console.log("service.logs.stdout.begin");
  console.log(await tailFile(paths.stdout, 64 * 1024));
  console.log("service.logs.stdout.end");
  console.log("service.logs.stderr.begin");
  console.log(await tailFile(paths.stderr, 64 * 1024));
  console.log("service.logs.stderr.end");
}

async function recoveryProbe(): Promise<void> {
  if (!(await isLoaded())) throw new Error("LaunchAgent is not loaded");
  const before = await readServiceState(paths.state);
  if (!before || before.phase !== "ready" || !isProcessAlive(before.pid)) {
    throw new Error("FLORAL service is not ready before recovery probe");
  }

  console.log(`service.recovery.old_pid=${before.pid}`);
  process.kill(before.pid, "SIGKILL");
  const after = await waitForReady(before.pid, 120_000);
  console.log(`service.recovery.new_pid=${after.pid}`);
  console.log("service.recovery.result=ok");
}

async function uninstall(): Promise<void> {
  if (await isLoaded()) await bootout();
  await rm(launchAgentPath, { force: true });
  console.log("service.uninstall=ok");
  console.log("service.data_preserved=true");
}

async function ensureBuild(): Promise<void> {
  await access(paths.runner, constants.R_OK);
  await access(paths.entry, constants.R_OK);
}

async function ensurePrivateEnv(): Promise<void> {
  const envPath = join(repositoryRoot, ".env");
  const metadata = await stat(envPath);
  if (!metadata.isFile()) throw new Error(".env must be a regular file");
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(".env permissions are too broad; run chmod 600 .env");
  }
  if (env.QQ_MODE !== "real" || env.CODEX_MODE !== "real") {
    throw new Error("LaunchAgent requires QQ_MODE=real and CODEX_MODE=real");
  }
  if (env.MOCK_TRUST_OWNER) {
    throw new Error("LaunchAgent requires MOCK_TRUST_OWNER=false");
  }
}

async function isLoaded(): Promise<boolean> {
  const result = await runCapture("/bin/launchctl", ["print", serviceTarget], true);
  return result.code === 0;
}

async function bootout(): Promise<void> {
  const result = await runCapture("/bin/launchctl", ["bootout", serviceTarget], true);
  if (result.code !== 0 && !/could not find service|no such process/i.test(result.stderr)) {
    throw new Error(`launchctl bootout failed with exit code ${String(result.code)}`);
  }
}

async function runLaunchctl(args: string[]): Promise<void> {
  const result = await runCapture("/bin/launchctl", args, false);
  if (result.code !== 0) {
    throw new Error(`launchctl ${args[0] ?? ""} failed with exit code ${String(result.code)}`);
  }
}

async function runExecutable(executable: string, args: string[]): Promise<void> {
  const result = await runCapture(executable, args, true);
  if (result.code !== 0) {
    throw new Error(`${executable} failed with exit code ${String(result.code)}`);
  }
}

async function waitForReady(
  previousPid: number | undefined,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await readServiceState(paths.state);
    if (
      state?.phase === "ready"
      && state.pid !== previousPid
      && isProcessAlive(state.pid)
    ) {
      return state;
    }
    await delay(1_000);
  }
  throw new Error("FLORAL service did not become ready before timeout");
}

async function waitForStopped(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await readServiceState(paths.state);
    if (!state || state.phase === "stopped" || !isProcessAlive(state.pid)) return;
    await delay(500);
  }
  throw new Error("FLORAL service did not stop before timeout");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function domainTarget(): string {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Unable to resolve current user id");
  return `gui/${String(uid)}`;
}

async function tailFile(path: string, maxBytes: number): Promise<string> {
  try {
    const value = await readFile(path);
    return value.subarray(Math.max(0, value.length - maxBytes)).toString("utf8").trimEnd();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "(no log file)";
    throw error;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function runCapture(
  executable: string,
  args: string[],
  allowFailure: boolean,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      cwd: repositoryRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const maxBytes = 128 * 1024;

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= maxBytes) stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= maxBytes) stderr.push(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      const result = {
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8").trim(),
        stderr: Buffer.concat(stderr).toString("utf8").trim(),
      };
      if (!allowFailure && result.code !== 0) {
        reject(new Error(`${executable} exited with code ${String(result.code)}`));
      } else {
        resolvePromise(result);
      }
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
