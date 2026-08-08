import { createHash } from "node:crypto";
import type {
  ResponsesBridgeRequest,
  TranslatedDeepSeekRequest,
} from "./bridge-types.js";

export const RESPONSES_BRIDGE_TELEMETRY_SCHEMA_VERSION = 1 as const;

export interface ResponsesBridgeRequestTelemetry {
  schemaVersion: typeof RESPONSES_BRIDGE_TELEMETRY_SCHEMA_VERSION;
  event: "request";
  requestId: number;
  at: string;
  requestedModel: string;
  translatedModel: string;
  instructionsPresent: boolean;
  instructionsBytes: number;
  instructionsFingerprint?: string;
  inputKind: "string" | "array" | "object" | "null" | "other";
  inputItemCount: number;
  inputTypes: string[];
  toolsCount: number;
  toolNames: string[];
  toolKinds: string[];
  translatedToolNames: string[];
  messageRoles: string[];
  maxOutputTokens?: number;
  parallelToolCalls?: boolean;
}

export interface ResponsesBridgeCompleteTelemetry {
  schemaVersion: typeof RESPONSES_BRIDGE_TELEMETRY_SCHEMA_VERSION;
  event: "complete";
  requestId: number;
  at: string;
  elapsedMs: number;
  providerModel?: string;
  finishReason?: string;
  sawText: boolean;
  sawReasoning: boolean;
  toolCallNames: string[];
  totalTokens?: number;
}

export interface ResponsesBridgeFailureTelemetry {
  schemaVersion: typeof RESPONSES_BRIDGE_TELEMETRY_SCHEMA_VERSION;
  event: "failure";
  requestId: number;
  at: string;
  elapsedMs: number;
  errorKind: string;
}

export type ResponsesBridgeTelemetryEvent =
  | ResponsesBridgeRequestTelemetry
  | ResponsesBridgeCompleteTelemetry
  | ResponsesBridgeFailureTelemetry;

export function buildResponsesBridgeRequestTelemetry(input: {
  requestId: number;
  atMs: number;
  request: ResponsesBridgeRequest;
  translated: TranslatedDeepSeekRequest;
}): ResponsesBridgeRequestTelemetry {
  const instructions = input.request.instructions;
  const tools = summarizeTools(input.request.tools);
  return {
    schemaVersion: RESPONSES_BRIDGE_TELEMETRY_SCHEMA_VERSION,
    event: "request",
    requestId: input.requestId,
    at: new Date(input.atMs).toISOString(),
    requestedModel: input.request.model,
    translatedModel: input.translated.model,
    instructionsPresent: typeof instructions === "string" && instructions.length > 0,
    instructionsBytes: typeof instructions === "string"
      ? Buffer.byteLength(instructions, "utf8")
      : 0,
    ...(typeof instructions === "string" && instructions.length > 0
      ? { instructionsFingerprint: shortFingerprint(instructions) }
      : {}),
    ...summarizeInput(input.request.input),
    toolsCount: tools.names.length,
    toolNames: tools.names,
    toolKinds: tools.kinds,
    translatedToolNames: input.translated.tools
      .map((tool) => tool.function.name)
      .slice(0, 48),
    messageRoles: input.translated.messages
      .map((message) => message.role)
      .slice(0, 64),
    ...(typeof input.request.max_output_tokens === "number"
      ? { maxOutputTokens: input.request.max_output_tokens }
      : {}),
    ...(typeof input.request.parallel_tool_calls === "boolean"
      ? { parallelToolCalls: input.request.parallel_tool_calls }
      : {}),
  };
}

export function renderResponsesBridgeTelemetryEvent(
  event: ResponsesBridgeTelemetryEvent,
): string {
  return `bridge.responses_telemetry=${JSON.stringify(event)}`;
}

function summarizeInput(value: unknown): {
  inputKind: ResponsesBridgeRequestTelemetry["inputKind"];
  inputItemCount: number;
  inputTypes: string[];
} {
  if (typeof value === "string") {
    return { inputKind: "string", inputItemCount: 1, inputTypes: ["string"] };
  }
  if (value === null) {
    return { inputKind: "null", inputItemCount: 0, inputTypes: [] };
  }
  if (Array.isArray(value)) {
    const types = new Set<string>();
    for (const item of value.slice(0, 64)) {
      types.add(itemType(item));
    }
    return {
      inputKind: "array",
      inputItemCount: value.length,
      inputTypes: [...types].sort(),
    };
  }
  if (typeof value === "object") {
    return {
      inputKind: "object",
      inputItemCount: 1,
      inputTypes: [itemType(value)],
    };
  }
  return {
    inputKind: "other",
    inputItemCount: 1,
    inputTypes: [typeof value],
  };
}

function itemType(value: unknown): string {
  if (typeof value !== "object" || value === null) return typeof value;
  const type = (value as Record<string, unknown>).type;
  return typeof type === "string" && type.trim() ? type : "object";
}

function summarizeTools(value: unknown[] | undefined): {
  names: string[];
  kinds: string[];
} {
  if (!value) return { names: [], kinds: [] };
  const names = new Set<string>();
  const kinds = new Set<string>();
  for (const entry of value.slice(0, 48)) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.type === "string") kinds.add(record.type);
    if (typeof record.name === "string" && record.name.trim()) {
      names.add(record.name);
    }
    if (record.type === "namespace" && Array.isArray(record.tools)) {
      const prefix = typeof record.name === "string" ? record.name : "";
      for (const nested of record.tools.slice(0, 48)) {
        if (typeof nested !== "object" || nested === null) continue;
        const nestedRecord = nested as Record<string, unknown>;
        if (typeof nestedRecord.name === "string" && nestedRecord.name.trim()) {
          names.add(`${prefix}${nestedRecord.name}`);
        }
      }
    }
  }
  return {
    names: [...names].sort().slice(0, 48),
    kinds: [...kinds].sort().slice(0, 16),
  };
}

function shortFingerprint(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16)}`;
}
