import { homedir, tmpdir, userInfo } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const FLORAL_PEEKABOO_GATEWAY_NAME = "floral-peekaboo";
export const FLORAL_PEEKABOO_GATEWAY_VERSION = "0.2.0";
export const FLORAL_PEEKABOO_GATEWAY_TOOLS = ["click", "image", "see"] as const;
export const FLORAL_PEEKABOO_MAX_DIMENSION = 1920;
export const FLORAL_PEEKABOO_SEE_MAX_DEPTH = 12;
export const FLORAL_PEEKABOO_SEE_MAX_ELEMENTS = 500;
export const FLORAL_PEEKABOO_SEE_MAX_CHILDREN = 100;

export type FloralPeekabooTargetInput = {
  app_target?: string | undefined;
};

export type FloralPeekabooClickInput = {
  snapshot: string;
  on: string;
  intent: string;
};

export function buildPeekabooChildEnvironment(): Record<string, string> {
  const username = userInfo().username;
  return {
    PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: homedir(),
    TMPDIR: tmpdir(),
    USER: username,
    LOGNAME: username,
    PEEKABOO_ALLOW_TOOLS: FLORAL_PEEKABOO_GATEWAY_TOOLS.join(","),
    PEEKABOO_AI_PROVIDERS: "",
    PEEKABOO_LOG_LEVEL: "warn",
  };
}

export function resolvePeekabooBridgeSocketPath(
  homeDirectory = homedir(),
): string {
  const home = homeDirectory.trim();
  if (!home || /[\r\n\0]/u.test(home)) {
    throw new Error("Peekaboo Bridge home directory is invalid");
  }
  const socketPath = join(home, "Library", "Application Support", "Peekaboo", "bridge.sock");
  if (!isAbsolute(socketPath)) {
    throw new Error("Peekaboo Bridge socket path must be absolute");
  }
  return socketPath;
}

export function buildPeekabooMcpArguments(bridgeSocket: string): string[] {
  const socket = bridgeSocket.trim();
  if (!socket || !isAbsolute(socket) || /[\r\n\0]/u.test(socket)) {
    throw new Error("Peekaboo Bridge socket path is invalid");
  }
  return ["mcp", "--bridge-socket", socket];
}

export function buildObservationArtifactPath(options: {
  allowedRoot: string;
  kind: "image" | "see";
  token: string;
}): string {
  const root = resolve(options.allowedRoot.trim());
  if (!root) throw new Error("FLORAL Peekaboo allowed root is required");
  if (!/^[A-Za-z0-9-]{8,128}$/u.test(options.token)) {
    throw new Error("FLORAL Peekaboo artifact token is invalid");
  }
  return join(root, `floral-peekaboo-${options.kind}-${options.token}.png`);
}

export function buildPeekabooClickArguments(
  input: FloralPeekabooClickInput,
): Record<string, unknown> {
  const snapshot = cleanOpaqueToken(input.snapshot, "snapshot", 256);
  const elementId = cleanOpaqueToken(input.on, "element id", 256);
  cleanIntent(input.intent);
  return {
    snapshot,
    on: elementId,
    foreground: false,
    background: true,
    double: false,
    right: false,
    wait_for: 5_000,
  };
}

export function buildPeekabooImageArguments(
  outputPath: string,
  input: FloralPeekabooTargetInput,
): Record<string, unknown> {
  const target = cleanTarget(input.app_target);
  return {
    path: outputPath,
    format: "png",
    capture_focus: "background",
    scale: "logical",
    max_dimension: FLORAL_PEEKABOO_MAX_DIMENSION,
    ...(target ? { app_target: target } : {}),
  };
}

export function buildPeekabooSeeArguments(
  outputPath: string,
  input: FloralPeekabooTargetInput,
): Record<string, unknown> {
  const target = cleanTarget(input.app_target);
  return {
    path: outputPath,
    annotate: false,
    max_depth: FLORAL_PEEKABOO_SEE_MAX_DEPTH,
    max_elements: FLORAL_PEEKABOO_SEE_MAX_ELEMENTS,
    max_children: FLORAL_PEEKABOO_SEE_MAX_CHILDREN,
    ...(target ? { app_target: target } : {}),
  };
}

export function assertObserveOnlyPeekabooToolSurface(names: readonly string[]): void {
  const actual = [...names].sort();
  const expected = [...FLORAL_PEEKABOO_GATEWAY_TOOLS].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Peekaboo controlled tool surface drift: expected ${expected.join(",")}, received ${actual.join(",")}`,
    );
  }
}

export function extractMcpTextContent(result: unknown): string {
  const content = (result as {
    content?: Array<{ type?: string; text?: unknown }>;
  }).content;
  return content
    ?.filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("\n")
    .trim() ?? "";
}

function cleanOpaqueToken(value: string, label: string, maxLength: number): string {
  const token = value.trim();
  if (!token || token.length > maxLength || /[\r\n\0]/u.test(token)) {
    throw new Error(`Peekaboo ${label} is invalid`);
  }
  return token;
}

function cleanIntent(value: string): string {
  const intent = value.replace(/[\u0000-\u001F\u007F]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (!intent || intent.length > 160) {
    throw new Error("Peekaboo click intent is invalid");
  }
  return intent;
}

function cleanTarget(value: string | undefined): string | undefined {
  const target = value?.trim();
  if (!target) return undefined;
  if (target.length > 256 || /[\r\n\0]/u.test(target)) {
    throw new Error("Peekaboo app_target is invalid");
  }
  return target;
}
