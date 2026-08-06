import { createHash } from "node:crypto";
import type {
  DeepSeekChatMessage,
  ToolBridgeDescriptor,
} from "./bridge-types.js";
import {
  parseResponsesRequest,
  translateResponsesRequest,
} from "./responses-translator.js";

export const CODEX_COMPATIBILITY_SCHEMA_VERSION = 1 as const;

const MAX_CAPTURE_DEPTH = 16;
const MAX_CAPTURE_ARRAY_ITEMS = 64;
const MAX_CAPTURE_OBJECT_KEYS = 128;
const SENSITIVE_KEY_PATTERN =
  /(authorization|api[-_]?key|token|secret|password|passwd|cookie|session|credential)/i;
const IDENTIFIER_KEYS = new Set([
  "call_id",
  "id",
  "item_id",
  "previous_response_id",
  "response_id",
]);
const PRESERVED_STRING_KEYS = new Set([
  "type",
  "role",
]);
const TOOL_NAME_CONTAINER_TYPES = new Set([
  "function",
  "custom",
  "namespace",
  "function_call",
  "custom_tool_call",
]);
const PRESERVED_STRING_ARRAY_KEYS = new Set([
  "required",
]);

export interface CapturedCodexResponsesRequest {
  schemaVersion: typeof CODEX_COMPATIBILITY_SCHEMA_VERSION;
  fingerprint: string;
  request: unknown;
}

export interface CodexCompatibilityCaptureArtifact {
  schemaVersion: typeof CODEX_COMPATIBILITY_SCHEMA_VERSION;
  generatedAt: string;
  source: {
    probe: string;
    codexVersion: string;
    platform: string;
    arch: string;
  };
  requests: Array<CapturedCodexResponsesRequest & { name: string }>;
}

export interface CodexCompatibilityFixture extends CapturedCodexResponsesRequest {
  name: string;
  context?: {
    reasoningByCallId?: Record<string, string> | undefined;
  } | undefined;
  expect: CodexCompatibilitySummary;
}

export interface CodexCompatibilitySummary {
  messageRoles: DeepSeekChatMessage["role"][];
  deepSeekToolNames: string[];
  toolDescriptors: ToolBridgeDescriptor[];
  assistantToolCalls: Array<{
    callId: string;
    name: string;
  }>;
  toolResultCallIds: string[];
  reasoningCallIds: string[];
  parallelToolCalls: boolean;
  maxTokens: number | null;
}

interface SanitizeState {
  readonly identifiers: Map<string, string>;
  nextIdentifier: number;
}

export function captureCodexResponsesRequest(
  value: unknown,
): CapturedCodexResponsesRequest {
  const request = sanitizeCodexResponsesRequest(value);
  return {
    schemaVersion: CODEX_COMPATIBILITY_SCHEMA_VERSION,
    fingerprint: fingerprintCodexResponsesRequest(request),
    request,
  };
}

export function sanitizeCodexResponsesRequest(value: unknown): unknown {
  const state: SanitizeState = {
    identifiers: new Map<string, string>(),
    nextIdentifier: 1,
  };
  return sanitizeValue(value, [], state, 0, undefined);
}

export function fingerprintCodexResponsesRequest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export function verifyCapturedCodexRequest(
  capture: CapturedCodexResponsesRequest,
): CodexCompatibilitySummary {
  assertSchemaVersion(capture.schemaVersion);
  const expectedFingerprint = fingerprintCodexResponsesRequest(capture.request);
  if (capture.fingerprint !== expectedFingerprint) {
    throw new Error(
      `Codex compatibility fingerprint mismatch: expected ${expectedFingerprint}, received ${capture.fingerprint}`,
    );
  }
  return summarizeCodexResponsesRequest(capture.request);
}

export function verifyCodexCompatibilityFixture(
  fixture: CodexCompatibilityFixture,
): CodexCompatibilitySummary {
  verifyCapturedCodexRequest(fixture);
  const context = fixture.context?.reasoningByCallId
    ? new Map(Object.entries(fixture.context.reasoningByCallId))
    : undefined;
  const replayed = summarizeCodexResponsesRequest(fixture.request, context);
  if (canonicalJson(replayed) !== canonicalJson(fixture.expect)) {
    throw new Error(
      `Codex compatibility fixture ${fixture.name} changed\nexpected=${canonicalJson(fixture.expect)}\nactual=${canonicalJson(replayed)}`,
    );
  }
  return replayed;
}

export function summarizeCodexResponsesRequest(
  requestValue: unknown,
  reasoningByCallId?: ReadonlyMap<string, string>,
): CodexCompatibilitySummary {
  const request = parseResponsesRequest(requestValue);
  const translated = translateResponsesRequest(
    request,
    "compatibility-target-model",
    reasoningByCallId ? { reasoningByCallId } : {},
  );

  const assistantToolCalls: CodexCompatibilitySummary["assistantToolCalls"] = [];
  const toolResultCallIds: string[] = [];
  const reasoningCallIds: string[] = [];

  for (const message of translated.messages) {
    if (message.role === "assistant" && message.tool_calls) {
      for (const call of message.tool_calls) {
        assistantToolCalls.push({
          callId: call.id,
          name: call.function.name,
        });
        if (message.reasoning_content) reasoningCallIds.push(call.id);
      }
    }
    if (message.role === "tool" && message.tool_call_id) {
      toolResultCallIds.push(message.tool_call_id);
    }
  }

  return {
    messageRoles: translated.messages.map((message) => message.role),
    deepSeekToolNames: translated.tools.map((tool) => tool.function.name),
    toolDescriptors: [...translated.toolMap.values()],
    assistantToolCalls,
    toolResultCallIds,
    reasoningCallIds,
    parallelToolCalls: translated.parallelToolCalls,
    maxTokens: translated.maxTokens ?? null,
  };
}

export function parseCodexCompatibilityFixture(
  value: unknown,
): CodexCompatibilityFixture {
  const record = asRecord(value);
  if (!record) throw new Error("Codex compatibility fixture must be an object");
  if (record.schemaVersion !== CODEX_COMPATIBILITY_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported Codex compatibility schema version: ${String(record.schemaVersion)}`,
    );
  }
  if (typeof record.name !== "string" || !record.name.trim()) {
    throw new Error("Codex compatibility fixture requires a name");
  }
  if (
    typeof record.fingerprint !== "string"
    || !record.fingerprint.startsWith("sha256:")
  ) {
    throw new Error(
      `Codex compatibility fixture ${record.name} requires a sha256 fingerprint`,
    );
  }
  if (!("request" in record)) {
    throw new Error(`Codex compatibility fixture ${record.name} requires request`);
  }
  const expectation = asRecord(record.expect);
  if (!expectation) {
    throw new Error(`Codex compatibility fixture ${record.name} requires expect`);
  }

  return record as unknown as CodexCompatibilityFixture;
}

export function parseCodexCompatibilityCaptureArtifact(
  value: unknown,
): CodexCompatibilityCaptureArtifact {
  const record = asRecord(value);
  if (!record) {
    throw new Error("Codex compatibility capture artifact must be an object");
  }
  if (record.schemaVersion !== CODEX_COMPATIBILITY_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported Codex capture schema version: ${String(record.schemaVersion)}`,
    );
  }
  if (!Array.isArray(record.requests)) {
    throw new Error("Codex compatibility capture artifact requires requests");
  }
  return record as unknown as CodexCompatibilityCaptureArtifact;
}

function sanitizeValue(
  value: unknown,
  path: string[],
  state: SanitizeState,
  depth: number,
  containerType: string | undefined,
): unknown {
  if (depth > MAX_CAPTURE_DEPTH) return "<truncated-depth>";
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }

  const key = path.at(-1) ?? "";
  const parentKey = path.at(-2) ?? "";

  if (typeof value === "string") {
    if (SENSITIVE_KEY_PATTERN.test(key)) return "<redacted>";
    if (IDENTIFIER_KEYS.has(key)) return normalizeIdentifier(value, state);
    if (key === "model") return "<model>";
    if (PRESERVED_STRING_KEYS.has(key)) return value;
    if (isPreservedToolIdentifier(path, key, containerType)) return value;
    if (PRESERVED_STRING_ARRAY_KEYS.has(parentKey)) return value;
    if (parentKey === "enum") return "<enum>";
    if (key === "arguments") return sanitizeArguments(value, state, depth + 1);
    return "<string>";
  }

  if (Array.isArray(value)) {
    const sanitized = value
      .slice(0, MAX_CAPTURE_ARRAY_ITEMS)
      .map((entry, index) =>
        sanitizeValue(entry, [...path, String(index)], state, depth + 1, undefined)
      );
    if (value.length > MAX_CAPTURE_ARRAY_ITEMS) sanitized.push("<truncated-array>");
    return sanitized;
  }

  const record = asRecord(value);
  if (!record) return "<unsupported>";

  const result: Record<string, unknown> = {};
  const recordType = typeof record.type === "string" ? record.type : undefined;
  const entries = Object.entries(record).slice(0, MAX_CAPTURE_OBJECT_KEYS);
  for (const [entryKey, entryValue] of entries) {
    result[entryKey] = SENSITIVE_KEY_PATTERN.test(entryKey)
      ? "<redacted>"
      : sanitizeValue(
          entryValue,
          [...path, entryKey],
          state,
          depth + 1,
          recordType,
        );
  }
  if (Object.keys(record).length > MAX_CAPTURE_OBJECT_KEYS) {
    result._capture_truncated = true;
  }
  return result;
}

function isPreservedToolIdentifier(
  path: string[],
  key: string,
  containerType: string | undefined,
): boolean {
  if (!containerType || !TOOL_NAME_CONTAINER_TYPES.has(containerType)) return false;
  if (path[0] === "tools" && key === "name") return true;
  if (
    path[0] === "input"
    && ["function_call", "custom_tool_call"].includes(containerType)
    && (key === "name" || key === "namespace")
  ) {
    return true;
  }
  return false;
}

function sanitizeArguments(
  value: string,
  state: SanitizeState,
  depth: number,
): string {
  try {
    const parsed = JSON.parse(value) as unknown;
    return canonicalJson(
      sanitizeValue(parsed, ["arguments_json"], state, depth, undefined),
    );
  } catch {
    return "<arguments>";
  }
}

function normalizeIdentifier(value: string, state: SanitizeState): string {
  const existing = state.identifiers.get(value);
  if (existing) return existing;
  const normalized = `id_${state.nextIdentifier}`;
  state.nextIdentifier += 1;
  state.identifiers.set(value, normalized);
  return normalized;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  const record = asRecord(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, sortValue(record[key])]),
  );
}

function assertSchemaVersion(value: unknown): void {
  if (value !== CODEX_COMPATIBILITY_SCHEMA_VERSION) {
    throw new Error(`Unsupported Codex compatibility schema version: ${String(value)}`);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}
