import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { CodexRuntimeError } from "./codex-errors.js";
import { CodexRpcClient } from "./codex-rpc-client.js";

const REPORT_RELATIVE_PATH = "data/config/codex-capabilities/baseline.json";
const PROCESS_OUTPUT_LIMIT = 1_048_576;

export interface CodexCapabilityProbeOptions {
  command: string;
  appServerArgs: string[];
  requestTimeoutMs: number;
  processCwd: string;
  processEnv: NodeJS.ProcessEnv;
  now?: Date | undefined;
}

export interface CodexProtocolCapabilities {
  threads: {
    list: boolean;
    read: boolean;
    fork: boolean;
    archive: boolean;
    delete: boolean;
    loadedList: boolean;
    turnsList: boolean;
  };
  config: {
    read: boolean;
    requirementsRead: boolean;
  };
  permissions: {
    profileSelection: boolean;
    activeProfileProjection: boolean;
    requestApproval: boolean;
    granularRequestPermissions: boolean;
    approvalsReviewerAutoReview: boolean;
    commandApprovalAcceptForSession: boolean;
    runtimeWorkspaceRoots: boolean;
  };
  instructions: {
    instructionSources: boolean;
  };
  memory: {
    threadMemoryModeSet: boolean;
    reset: boolean;
  };
  command: {
    exec: boolean;
  };
}

export type CodexRpcProbeStatus = "ok" | "unsupported" | "error" | "skipped";

export interface CodexRpcProbeResult {
  status: CodexRpcProbeStatus;
  kind?: string | undefined;
  code?: number | undefined;
}

export interface CodexCapabilityRequirementsSummary {
  present: boolean;
  allowedApprovalPolicies?: string[] | undefined;
  allowedApprovalsReviewers?: string[] | undefined;
  allowedSandboxModes?: string[] | undefined;
  allowedPermissionProfiles?: Record<string, boolean> | undefined;
  defaultPermissions?: string | undefined;
  allowRemoteControl?: boolean | undefined;
  autoReviewConfigured?: boolean | undefined;
  networkRequirementsConfigured?: boolean | undefined;
}

export interface CodexEffectiveConfigSummary {
  approvalPolicy?: string | undefined;
  approvalsReviewer?: string | undefined;
  sandboxMode?: string | undefined;
}

export interface CodexReadinessCheck {
  status: "ready" | "blocked";
  missing: string[];
}

export interface CodexCapabilityBaseline {
  schemaVersion: 1;
  phase: "7.0";
  generatedAt: string;
  codex: {
    version: string;
    protocolSchemaFiles: number;
    protocolSchemaSha256: string;
  };
  protocol: CodexProtocolCapabilities;
  runtime: {
    initialize: {
      status: "ok";
      platformFamily?: string | undefined;
      platformOs?: string | undefined;
      userAgent?: string | undefined;
    };
    rpc: {
      configRead: CodexRpcProbeResult;
      configRequirementsRead: CodexRpcProbeResult;
      threadList: CodexRpcProbeResult;
      threadLoadedList: CodexRpcProbeResult;
    };
    effectiveConfig: CodexEffectiveConfigSummary;
    requirements: CodexCapabilityRequirementsSummary;
  };
  readiness: {
    permissionAlignment: CodexReadinessCheck;
    projectChat: CodexReadinessCheck;
    sharedContext: CodexReadinessCheck;
    nativeMemory: CodexReadinessCheck;
  };
  compatibilityFingerprint: string;
  reportFingerprint: string;
}

interface SchemaBundle {
  files: number;
  sha256: string;
  text: string;
}

interface RuntimeProbeSummary {
  initialize: CodexCapabilityBaseline["runtime"]["initialize"];
  rpc: CodexCapabilityBaseline["runtime"]["rpc"];
  effectiveConfig: CodexEffectiveConfigSummary;
  requirements: CodexCapabilityRequirementsSummary;
}

export async function collectCodexCapabilityBaseline(
  options: CodexCapabilityProbeOptions,
): Promise<CodexCapabilityBaseline> {
  const command = options.command.trim();
  if (!command) throw new Error("Codex capability probe command must not be empty");
  if (
    !Number.isInteger(options.requestTimeoutMs)
    || options.requestTimeoutMs < 1_000
  ) {
    throw new Error("Codex capability probe timeout must be at least 1000 ms");
  }

  const invocation = splitAppServerInvocation(options.appServerArgs);
  const versionResult = await runProcess({
    command,
    args: [...invocation.prefixArgs, "--version"],
    cwd: options.processCwd,
    env: options.processEnv,
    timeoutMs: options.requestTimeoutMs,
  });
  const version = firstNonEmptyLine(versionResult.stdout)
    ?? firstNonEmptyLine(versionResult.stderr)
    ?? "<unknown>";

  const schemaBundle = await generateSchemaBundle({
    command,
    prefixArgs: invocation.prefixArgs,
    cwd: options.processCwd,
    env: options.processEnv,
    timeoutMs: options.requestTimeoutMs,
  });
  const protocol = analyzeCodexProtocolSchema(schemaBundle.text);

  const runtime = await probeReadOnlyRuntime({
    command,
    appServerArgs: options.appServerArgs,
    cwd: options.processCwd,
    env: options.processEnv,
    timeoutMs: options.requestTimeoutMs,
    protocol,
  });

  const readiness = buildReadiness(protocol, runtime);
  const compatibilityPayload = {
    protocol,
    runtime: {
      rpc: mapRpcStatuses(runtime.rpc),
      effectiveConfig: runtime.effectiveConfig,
      requirements: runtime.requirements,
    },
    readiness,
  };
  const compatibilityFingerprint = sha256(stableStringify(compatibilityPayload));

  const withoutReportFingerprint = {
    schemaVersion: 1 as const,
    phase: "7.0" as const,
    generatedAt: (options.now ?? new Date()).toISOString(),
    codex: {
      version: sanitizeSingleLine(version, 160),
      protocolSchemaFiles: schemaBundle.files,
      protocolSchemaSha256: schemaBundle.sha256,
    },
    protocol,
    runtime,
    readiness,
    compatibilityFingerprint,
  };

  return {
    ...withoutReportFingerprint,
    reportFingerprint: sha256(stableStringify({
      ...withoutReportFingerprint,
      generatedAt: "<generated-at>",
    })),
  };
}

export function analyzeCodexProtocolSchema(text: string): CodexProtocolCapabilities {
  const has = (value: string) => text.includes(JSON.stringify(value));
  return {
    threads: {
      list: has("thread/list"),
      read: has("thread/read"),
      fork: has("thread/fork"),
      archive: has("thread/archive"),
      delete: has("thread/delete"),
      loadedList: has("thread/loaded/list"),
      turnsList: has("thread/turns/list"),
    },
    config: {
      read: has("config/read"),
      requirementsRead: has("configRequirements/read"),
    },
    permissions: {
      profileSelection: has("permissionProfile"),
      activeProfileProjection: has("activePermissionProfile"),
      requestApproval: has("item/permissions/requestApproval"),
      granularRequestPermissions: has("request_permissions"),
      approvalsReviewerAutoReview: has("auto_review"),
      commandApprovalAcceptForSession: has("acceptForSession"),
      runtimeWorkspaceRoots: has("runtimeWorkspaceRoots"),
    },
    instructions: {
      instructionSources: has("instructionSources"),
    },
    memory: {
      threadMemoryModeSet: has("thread/memoryMode/set"),
      reset: has("memory/reset"),
    },
    command: {
      exec: has("command/exec"),
    },
  };
}

export function assessCodexCapabilityBaseline(
  approved: CodexCapabilityBaseline,
  current: CodexCapabilityBaseline,
): "compatible" | "drift" {
  return approved.compatibilityFingerprint === current.compatibilityFingerprint
    ? "compatible"
    : "drift";
}

export async function writeCodexCapabilityBaseline(
  repositoryRoot: string,
  report: CodexCapabilityBaseline,
): Promise<string> {
  validateReport(report);
  const path = join(resolve(repositoryRoot), REPORT_RELATIVE_PATH);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = `${path}.tmp-${String(process.pid)}-${Date.now().toString(36)}`;
  try {
    await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
  return path;
}

export async function readCodexCapabilityBaseline(
  repositoryRoot: string,
): Promise<CodexCapabilityBaseline | undefined> {
  const path = join(resolve(repositoryRoot), REPORT_RELATIVE_PATH);
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    const report = parsed as CodexCapabilityBaseline;
    validateReport(report);
    return report;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

export function renderCodexCapabilityBaseline(
  report: CodexCapabilityBaseline,
): string {
  const lines = [
    "codex.capabilities.phase=7.0",
    `codex.capabilities.version=${safeLogToken(report.codex.version)}`,
    `codex.capabilities.protocol_schema_files=${String(report.codex.protocolSchemaFiles)}`,
    `codex.capabilities.protocol_schema_sha256=${report.codex.protocolSchemaSha256}`,
    `codex.capabilities.thread.list=${String(report.protocol.threads.list)}`,
    `codex.capabilities.thread.read=${String(report.protocol.threads.read)}`,
    `codex.capabilities.thread.fork=${String(report.protocol.threads.fork)}`,
    `codex.capabilities.thread.archive=${String(report.protocol.threads.archive)}`,
    `codex.capabilities.thread.delete=${String(report.protocol.threads.delete)}`,
    `codex.capabilities.config.read=${String(report.protocol.config.read)}`,
    `codex.capabilities.config_requirements.read=${String(report.protocol.config.requirementsRead)}`,
    `codex.capabilities.permissions.profile_selection=${String(report.protocol.permissions.profileSelection)}`,
    `codex.capabilities.permissions.request_approval=${String(report.protocol.permissions.requestApproval)}`,
    `codex.capabilities.permissions.granular_request_permissions=${String(report.protocol.permissions.granularRequestPermissions)}`,
    `codex.capabilities.permissions.auto_review=${String(report.protocol.permissions.approvalsReviewerAutoReview)}`,
    `codex.capabilities.permissions.accept_for_session=${String(report.protocol.permissions.commandApprovalAcceptForSession)}`,
    `codex.capabilities.instructions.sources=${String(report.protocol.instructions.instructionSources)}`,
    `codex.capabilities.memory.thread_mode=${String(report.protocol.memory.threadMemoryModeSet)}`,
    `codex.capabilities.memory.reset=${String(report.protocol.memory.reset)}`,
    `codex.capabilities.runtime.config_read=${report.runtime.rpc.configRead.status}`,
    `codex.capabilities.runtime.config_requirements_read=${report.runtime.rpc.configRequirementsRead.status}`,
    `codex.capabilities.runtime.thread_list=${report.runtime.rpc.threadList.status}`,
    `codex.capabilities.runtime.thread_loaded_list=${report.runtime.rpc.threadLoadedList.status}`,
    `codex.capabilities.readiness.permission_alignment=${report.readiness.permissionAlignment.status}`,
    `codex.capabilities.readiness.project_chat=${report.readiness.projectChat.status}`,
    `codex.capabilities.readiness.shared_context=${report.readiness.sharedContext.status}`,
    `codex.capabilities.readiness.native_memory=${report.readiness.nativeMemory.status}`,
    `codex.capabilities.compatibility_fingerprint=${report.compatibilityFingerprint}`,
    `codex.capabilities.report_fingerprint=${report.reportFingerprint}`,
  ];
  for (const [name, readiness] of Object.entries(report.readiness)) {
    if (readiness.missing.length === 0) continue;
    lines.push(
      `codex.capabilities.readiness.${camelToSnake(name)}.missing=${readiness.missing.join(",")}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function buildReadiness(
  protocol: CodexProtocolCapabilities,
  runtime: RuntimeProbeSummary,
): CodexCapabilityBaseline["readiness"] {
  return {
    permissionAlignment: readiness([
      [protocol.config.read, "config/read"],
      [runtime.rpc.configRead.status === "ok", "runtime:config/read"],
      [protocol.config.requirementsRead, "configRequirements/read"],
      [runtime.rpc.configRequirementsRead.status === "ok", "runtime:configRequirements/read"],
      [protocol.permissions.profileSelection, "permissionProfile"],
      [protocol.permissions.requestApproval, "item/permissions/requestApproval"],
      [protocol.permissions.granularRequestPermissions, "granular.request_permissions"],
      [protocol.permissions.approvalsReviewerAutoReview, "approvalsReviewer:auto_review"],
    ]),
    projectChat: readiness([
      [protocol.threads.list, "thread/list"],
      [runtime.rpc.threadList.status === "ok", "runtime:thread/list(cwd)"],
      [protocol.threads.read, "thread/read"],
      [protocol.threads.fork, "thread/fork"],
      [protocol.threads.archive, "thread/archive"],
      [protocol.threads.delete, "thread/delete"],
    ]),
    sharedContext: readiness([
      [protocol.instructions.instructionSources, "instructionSources"],
    ]),
    nativeMemory: readiness([
      [protocol.memory.threadMemoryModeSet, "thread/memoryMode/set"],
      [protocol.memory.reset, "memory/reset"],
    ]),
  };
}

function readiness(checks: Array<readonly [boolean, string]>): CodexReadinessCheck {
  const missing = checks
    .filter(([supported]) => !supported)
    .map(([, name]) => name);
  return {
    status: missing.length === 0 ? "ready" : "blocked",
    missing,
  };
}

async function probeReadOnlyRuntime(input: {
  command: string;
  appServerArgs: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  protocol: CodexProtocolCapabilities;
}): Promise<RuntimeProbeSummary> {
  const client = new CodexRpcClient({
    command: input.command,
    args: input.appServerArgs,
    requestTimeoutMs: input.timeoutMs,
    cwd: input.cwd,
    env: input.env,
  });
  await client.start();
  try {
    const initializeRaw = await client.initialize(
      {
        name: "floral_codex_capability_probe",
        title: "FLORAL Codex Capability Probe",
        version: "7.0",
      },
      { experimentalApi: true },
    );
    const initializeRecord = asRecord(initializeRaw);
    const initialize = {
      status: "ok" as const,
      ...optionalStringProperty("platformFamily", initializeRecord?.platformFamily),
      ...optionalStringProperty("platformOs", initializeRecord?.platformOs),
      ...optionalStringProperty("userAgent", initializeRecord?.userAgent),
    };

    const configRead = await probeRpc(
      client,
      input.protocol.config.read,
      "config/read",
      {
        includeLayers: false,
        cwd: input.cwd,
      },
    );
    const configRequirementsRead = await probeRpc(
      client,
      input.protocol.config.requirementsRead,
      "configRequirements/read",
      null,
    );
    const threadList = await probeRpc(
      client,
      input.protocol.threads.list,
      "thread/list",
      { limit: 1, cwd: input.cwd },
    );
    const threadLoadedList = await probeRpc(
      client,
      input.protocol.threads.loadedList,
      "thread/loaded/list",
      null,
    );

    return {
      initialize,
      rpc: {
        configRead: configRead.probe,
        configRequirementsRead: configRequirementsRead.probe,
        threadList: threadList.probe,
        threadLoadedList: threadLoadedList.probe,
      },
      effectiveConfig: configRead.probe.status === "ok"
        ? summarizeEffectiveConfig(configRead.result)
        : {},
      requirements: configRequirementsRead.probe.status === "ok"
        ? summarizeRequirements(configRequirementsRead.result)
        : { present: false },
    };
  } finally {
    await client.stop();
  }
}

async function probeRpc(
  client: CodexRpcClient,
  declaredSupported: boolean,
  method: string,
  params: unknown,
): Promise<{ probe: CodexRpcProbeResult; result?: unknown | undefined }> {
  if (!declaredSupported) {
    return { probe: { status: "skipped" } };
  }
  try {
    const result = await client.request(method, params);
    return { probe: { status: "ok" }, result };
  } catch (error) {
    if (error instanceof CodexRuntimeError && error.code === -32601) {
      return {
        probe: {
          status: "unsupported",
          kind: error.kind,
          code: error.code,
        },
      };
    }
    if (error instanceof CodexRuntimeError) {
      return {
        probe: {
          status: "error",
          kind: error.kind,
          ...(error.code === undefined ? {} : { code: error.code }),
        },
      };
    }
    return {
      probe: {
        status: "error",
        kind: error instanceof Error ? error.name : "Error",
      },
    };
  }
}

function summarizeEffectiveConfig(value: unknown): CodexEffectiveConfigSummary {
  const outer = asRecord(value);
  const config = asRecord(outer?.config);
  if (!config) return {};
  const approvalPolicy = readApprovalPolicy(
    readFirst(config, ["approval_policy", "approvalPolicy"]),
  );
  const approvalsReviewer = readFirstString(config, ["approvals_reviewer", "approvalsReviewer"]);
  const sandboxMode = readFirstString(config, ["sandbox_mode", "sandboxMode"]);
  return {
    ...(approvalPolicy ? { approvalPolicy } : {}),
    ...(approvalsReviewer ? { approvalsReviewer } : {}),
    ...(sandboxMode ? { sandboxMode } : {}),
  };
}

function summarizeRequirements(value: unknown): CodexCapabilityRequirementsSummary {
  const outer = asRecord(value);
  const requirements = asRecord(outer?.requirements);
  if (!requirements) return { present: false };

  const allowedApprovalPolicies = readApprovalPolicies(
    readFirst(requirements, ["allowedApprovalPolicies", "allowed_approval_policies"]),
  );
  const allowedApprovalsReviewers = readStringArray(
    readFirst(requirements, ["allowedApprovalsReviewers", "allowed_approvals_reviewers"]),
  );
  const allowedSandboxModes = readStringArray(
    readFirst(requirements, ["allowedSandboxModes", "allowed_sandbox_modes"]),
  );
  const allowedPermissionProfiles = readBooleanMap(
    readFirst(requirements, ["allowedPermissionProfiles", "allowed_permission_profiles"]),
  );
  const defaultPermissions = readString(
    readFirst(requirements, ["defaultPermissions", "default_permissions"]),
  );
  const allowRemoteControl = readBoolean(
    readFirst(requirements, ["allowRemoteControl", "allow_remote_control"]),
  );
  const autoReviewValue = readFirst(requirements, ["autoReview", "auto_review"]);
  const networkValue = readFirst(requirements, ["network"]);

  return {
    present: true,
    ...(allowedApprovalPolicies ? { allowedApprovalPolicies } : {}),
    ...(allowedApprovalsReviewers ? { allowedApprovalsReviewers } : {}),
    ...(allowedSandboxModes ? { allowedSandboxModes } : {}),
    ...(allowedPermissionProfiles ? { allowedPermissionProfiles } : {}),
    ...(defaultPermissions ? { defaultPermissions } : {}),
    ...(allowRemoteControl === undefined ? {} : { allowRemoteControl }),
    ...(autoReviewValue === undefined
      ? {}
      : { autoReviewConfigured: autoReviewValue !== null }),
    ...(networkValue === undefined
      ? {}
      : { networkRequirementsConfigured: networkValue !== null }),
  };
}

async function generateSchemaBundle(input: {
  command: string;
  prefixArgs: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}): Promise<SchemaBundle> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "floral-codex-capabilities-"));
  const schemaRoot = join(temporaryRoot, "json");
  try {
    await mkdir(schemaRoot, { recursive: true });
    await runProcess({
      command: input.command,
      args: [
        ...input.prefixArgs,
        "app-server",
        "generate-json-schema",
        "--out",
        schemaRoot,
      ],
      cwd: input.cwd,
      env: input.env,
      timeoutMs: input.timeoutMs,
    });

    const paths = await listJsonFiles(schemaRoot);
    if (paths.length === 0) {
      throw new Error("Codex app-server generated no JSON schema files");
    }

    const records: Array<{ path: string; content: string }> = [];
    for (const path of paths) {
      const content = await readFile(path, "utf8");
      records.push({
        path: relative(schemaRoot, path).replaceAll("\\", "/"),
        content,
      });
    }
    records.sort((left, right) => left.path.localeCompare(right.path));

    const fingerprintInput = records
      .map((record) => `${record.path}\u0000${record.content}`)
      .join("\u0000");
    return {
      files: records.length,
      sha256: sha256(fingerprintInput),
      text: records.map((record) => record.content).join("\n"),
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function listJsonFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        output.push(path);
      }
    }
  };
  await visit(root);
  return output;
}

function splitAppServerInvocation(args: string[]): { prefixArgs: string[] } {
  const index = args.indexOf("app-server");
  if (index < 0) {
    throw new Error(
      "Codex capability probe requires CODEX args containing the app-server subcommand",
    );
  }
  return { prefixArgs: args.slice(0, index) };
}

async function runProcess(input: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (
      error?: Error,
      result?: { stdout: string; stderr: string },
    ) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) rejectPromise(error);
      else resolvePromise(result ?? { stdout, stderr });
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout = appendLimited(stdout, String(chunk));
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = appendLimited(stderr, String(chunk));
    });
    child.once("error", (error) => {
      finish(new Error(`Unable to start Codex command: ${error.message}`, { cause: error }));
    });
    child.once("close", (code, signal) => {
      if (code === 0) {
        finish(undefined, { stdout, stderr });
        return;
      }
      finish(new Error(
        `Codex command failed (code=${String(code)}, signal=${String(signal)}): ${
          sanitizeSingleLine(stderr || stdout || "no output", 240)
        }`,
      ));
    });

    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(
        `Codex command timed out after ${String(input.timeoutMs)} ms`,
      ));
    }, input.timeoutMs);
  });
}

function appendLimited(current: string, next: string): string {
  const combined = current + next;
  return combined.length <= PROCESS_OUTPUT_LIMIT
    ? combined
    : combined.slice(combined.length - PROCESS_OUTPUT_LIMIT);
}

function mapRpcStatuses(
  rpc: RuntimeProbeSummary["rpc"],
): Record<string, CodexRpcProbeStatus> {
  return {
    configRead: rpc.configRead.status,
    configRequirementsRead: rpc.configRequirementsRead.status,
    threadList: rpc.threadList.status,
    threadLoadedList: rpc.threadLoadedList.status,
  };
}

function readApprovalPolicy(value: unknown): string | undefined {
  if (typeof value === "string") return sanitizeSingleLine(value, 80);
  const record = asRecord(value);
  return record?.granular !== undefined ? "granular" : undefined;
}

function readApprovalPolicies(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const output: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      output.push(sanitizeSingleLine(entry, 80));
      continue;
    }
    const record = asRecord(entry);
    if (record?.granular !== undefined) output.push("granular");
  }
  return output.length > 0 ? [...new Set(output)].sort() : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const output = value
    .filter(
      (entry): entry is string => typeof entry === "string" && entry.length > 0,
    )
    .map((entry) => sanitizeSingleLine(entry, 80))
    .filter(Boolean);
  return output.length > 0 ? [...new Set(output)].sort() : undefined;
}

function readBooleanMap(value: unknown): Record<string, boolean> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const output: Record<string, boolean> = {};
  for (const key of Object.keys(record).sort()) {
    const candidate = record[key];
    if (typeof candidate === "boolean") output[key] = candidate;
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function readFirst(
  record: Record<string, unknown>,
  keys: string[],
): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) return record[key];
  }
  return undefined;
}

function readFirstString(
  record: Record<string, unknown>,
  keys: string[],
): string | undefined {
  return readString(readFirst(record, keys));
}

function optionalStringProperty(
  key: "platformFamily" | "platformOs" | "userAgent",
  value: unknown,
): Partial<Record<"platformFamily" | "platformOs" | "userAgent", string>> {
  const parsed = readString(value);
  return parsed ? { [key]: sanitizeSingleLine(parsed, 160) } : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim()
    ? sanitizeSingleLine(value, 240)
    : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

function firstNonEmptyLine(value: string): string | undefined {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
}

function validateReport(report: CodexCapabilityBaseline): void {
  if (
    report?.schemaVersion !== 1
    || report.phase !== "7.0"
    || typeof report.generatedAt !== "string"
    || typeof report.compatibilityFingerprint !== "string"
    || typeof report.reportFingerprint !== "string"
    || typeof report.codex?.version !== "string"
    || typeof report.codex?.protocolSchemaSha256 !== "string"
    || typeof report.protocol !== "object"
    || typeof report.runtime !== "object"
    || typeof report.readiness !== "object"
  ) {
    throw new Error("Invalid Codex capability baseline report");
  }
  const { reportFingerprint, ...withoutFingerprint } = report;
  const expected = sha256(stableStringify({
    ...withoutFingerprint,
    generatedAt: "<generated-at>",
  }));
  if (reportFingerprint !== expected) {
    throw new Error("Invalid Codex capability baseline report fingerprint");
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT"
  );
}

function sanitizeSingleLine(value: string, maxLength: number): string {
  return value
    .replace(/[\u0000-\u001F\u007F]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxLength);
}

function safeLogToken(value: string): string {
  const normalized = sanitizeSingleLine(value, 160)
    .replace(/[^A-Za-z0-9._:+/-]+/gu, "_");
  return normalized || "unknown";
}

function camelToSnake(value: string): string {
  return value.replace(/[A-Z]/gu, (match) => `_${match.toLowerCase()}`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortForStableJson(value));
}

function sortForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForStableJson);
  const record = asRecord(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, sortForStableJson(record[key])]),
  );
}
