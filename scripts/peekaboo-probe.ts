import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  rm,
  stat,
} from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { resolveConfigurationAuthority } from "../src/config/federation/config-authority.js";
import { loadProjectEnv } from "../src/config/load-project-env.js";

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 30_000;
const MAX_JSON_BYTES = 12 * 1024 * 1024;

if (process.platform !== "darwin") {
  throw new Error("peekaboo:probe is macOS-only");
}

loadProjectEnv();

const repositoryRoot = process.cwd();
const authority = await resolveConfigurationAuthority({
  repositoryRoot,
  environment: process.env,
});
const configuredCommand = authority.effective.macos.peekaboo_command;
const command = await resolveExecutable(configuredCommand);
const macos = authority.effective.mcp.macos;
const expectedTools = [...macos.enabled_tools].sort();

if (!macos.enabled) {
  throw new Error("mcp.macos.enabled must be true before running the Phase 6A probe");
}
if (macos.profile !== "observe") {
  throw new Error("Phase 6A probe requires mcp.macos.profile=observe");
}
if (expectedTools.join(",") !== "image,see") {
  throw new Error(
    `Phase 6A observe-only tool surface must be exactly image,see; received ${expectedTools.join(",")}`,
  );
}

const childEnv = buildPeekabooEnvironment(expectedTools);
const versionResult = await run(["--version"]);
const version = extractVersion(versionResult.stdout || versionResult.stderr);
if (version !== macos.expected_version) {
  throw new Error(
    `Peekaboo version drift: expected ${macos.expected_version}, received ${version}`,
  );
}

await run(["mcp", "--help"]);
const toolsResult = await run(["tools", "--json"]);
const advertisedTools = extractToolNames(parseJson(toolsResult.stdout, "tools"));
for (const toolName of expectedTools) {
  if (!advertisedTools.has(toolName)) {
    throw new Error(`Peekaboo tool allowlist is missing ${toolName}`);
  }
}
for (const toolName of advertisedTools) {
  if (!expectedTools.includes(toolName)) {
    throw new Error(`Peekaboo unexpectedly advertised tool outside allowlist: ${toolName}`);
  }
}

await run(["permissions", "status"]);

const outboundRoot = resolve(authority.effective.codex.cwd, "artifacts", "outbound");
const capturePath = join(outboundRoot, "phase6a-peekaboo-probe.png");
await mkdir(outboundRoot, { recursive: true, mode: 0o700 });
await chmod(outboundRoot, 0o700);
await rm(capturePath, { force: true });

try {
  await run(["image", "--mode", "screen", "--path", capturePath]);
  await chmod(capturePath, 0o600);
  const capture = await stat(capturePath);
  if (!capture.isFile() || capture.size <= 0) {
    throw new Error("Peekaboo image probe did not create a non-empty screenshot");
  }

  // `see` exercises the accessibility inspection path. Never echo the JSON:
  // it may contain window titles or visible UI text.
  const see = await run(["see", "--app", "Finder", "--json"]);
  parseJson(see.stdout, "see");

  console.log(`peekaboo.probe.version=${version}`);
  console.log(`peekaboo.probe.command=${command}`);
  console.log(`peekaboo.probe.tools=${expectedTools.join(",")}`);
  console.log("peekaboo.probe.permissions_command=ok");
  console.log(`peekaboo.probe.capture_bytes=${String(capture.size)}`);
  console.log("peekaboo.probe.capture=ok");
  console.log("peekaboo.probe.see=ok");
  console.log("peekaboo.probe.ai_providers=disabled");
  console.log("peekaboo.probe.result=ok");
} finally {
  // Diagnostic captures are not durable artifacts and must not remain eligible
  // for later accidental egress.
  await rm(capturePath, { force: true });
}

async function run(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return await execFileAsync(command, args, {
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: MAX_JSON_BYTES,
    env: childEnv,
  });
}

function buildPeekabooEnvironment(tools: string[]): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    PEEKABOO_ALLOW_TOOLS: tools.join(","),
    PEEKABOO_AI_PROVIDERS: "",
    PEEKABOO_LOG_LEVEL: "warn",
  };
  for (const key of ["PATH", "HOME", "TMPDIR", "USER", "LOGNAME", "LANG", "LC_ALL"] as const) {
    const value = process.env[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

async function resolveExecutable(value: string): Promise<string> {
  const candidate = value.trim();
  if (!candidate) throw new Error("macos.peekaboo_command must not be empty");

  if (isAbsolute(candidate)) {
    await access(candidate, fsConstants.X_OK);
    return candidate;
  }
  if (candidate.includes("/") || candidate.includes("\\")) {
    throw new Error(
      "Relative Peekaboo paths are forbidden; use a bare command or an absolute path",
    );
  }

  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
    if (!entry) continue;
    const path = join(entry, candidate);
    try {
      await access(path, fsConstants.X_OK);
      return path;
    } catch {
      // Continue searching PATH.
    }
  }
  throw new Error(
    `Could not resolve ${candidate} on PATH. Install Peekaboo or set PEEKABOO_COMMAND to an absolute path.`,
  );
}

function extractVersion(value: string): string {
  const match = /\b(\d+\.\d+\.\d+)\b/u.exec(value);
  if (!match?.[1]) {
    throw new Error("Peekaboo --version did not contain a semantic version");
  }
  return match[1];
}

function parseJson(value: string, label: string): unknown {
  if (Buffer.byteLength(value, "utf8") > MAX_JSON_BYTES) {
    throw new Error(`Peekaboo ${label} JSON exceeded the probe limit`);
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`Peekaboo ${label} output was not valid JSON`);
  }
}

function extractToolNames(value: unknown): Set<string> {
  const names = new Set<string>();
  walk(value);
  return names;

  function walk(current: unknown): void {
    if (Array.isArray(current)) {
      for (const item of current) walk(item);
      return;
    }
    if (!isRecord(current)) return;

    for (const [key, nested] of Object.entries(current)) {
      const normalizedKey = key.replace(/-/gu, "_").toLowerCase();
      if (
        (key === "name" || key === "tool" || key === "id")
        && typeof nested === "string"
        && /^[A-Za-z0-9_-]+$/u.test(nested)
      ) {
        names.add(nested.replace(/-/gu, "_").toLowerCase());
      }
      if (expectedTools.includes(normalizedKey)) names.add(normalizedKey);
      walk(nested);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
