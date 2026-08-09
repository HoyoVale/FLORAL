import type {
  SystemEvidence,
  SystemEvidenceConfidence,
  SystemEvidenceScope,
  SystemEvidenceSourceKind,
  SystemEvidenceValue,
} from "../system-types.js";

export interface EvidenceInput {
  componentId: string;
  fact: string;
  sourceId: string;
  sourceKind: SystemEvidenceSourceKind;
  confidence: SystemEvidenceConfidence;
  scope: SystemEvidenceScope;
  value: SystemEvidenceValue;
  observedAt: string;
  reason?: string | undefined;
}

export function evidence(input: EvidenceInput): SystemEvidence {
  return {
    componentId: input.componentId,
    fact: input.fact,
    source: {
      id: input.sourceId,
      kind: input.sourceKind,
    },
    observedAt: input.observedAt,
    confidence: input.confidence,
    scope: input.scope,
    value: input.value,
    ...(input.reason ? { reason: input.reason } : {}),
  };
}

export function errorType(error: unknown): string {
  if (error instanceof Error && error.name.trim()) return safeToken(error.name);
  return "Error";
}

export function safeReason(value: string): string {
  return safeToken(value);
}

function safeToken(value: string): string {
  const normalized = value
    .replace(/[^A-Za-z0-9._:-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 96);
  return normalized || "unknown";
}
