import { SystemDefinitionRegistry } from "./system-definition-registry.js";
import {
  SYSTEM_AWARENESS_SCHEMA_VERSION,
  type SystemComponentSnapshot,
  type SystemEvidence,
  type SystemEvidenceConfidence,
  type SystemEvidenceValue,
  type SystemFactSnapshot,
  type SystemObservationContext,
  type SystemObserver,
  type SystemObserverSnapshot,
  type SystemSnapshot,
} from "./system-types.js";

const FACT_PATTERN = /^[a-z][a-z0-9]*(?:[._:/-][a-z0-9]+)*$/u;
const SOURCE_PATTERN = FACT_PATTERN;

export interface SystemSnapshotBuilderOptions {
  registry: SystemDefinitionRegistry;
  observers: readonly SystemObserver[];
  now?: (() => Date) | undefined;
}

export class SystemSnapshotBuilder {
  readonly #registry: SystemDefinitionRegistry;
  readonly #observers: readonly SystemObserver[];
  readonly #now: () => Date;

  constructor(options: SystemSnapshotBuilderOptions) {
    this.#registry = options.registry;
    this.#observers = [...options.observers];
    this.#now = options.now ?? (() => new Date());
    validateObservers(this.#registry, this.#observers);
  }

  async build(context: SystemObservationContext = {}): Promise<SystemSnapshot> {
    const evidenceByComponent = new Map<string, SystemEvidence[]>();
    const observerSnapshots: SystemObserverSnapshot[] = [];

    for (const observer of this.#observers) {
      try {
        const observed = await observer.observe(context);
        const validated = observed.map((item) => {
          if (!observer.componentIds.includes(item.componentId)) {
            throw new Error(
              `System observer ${observer.id} emitted undeclared component ${item.componentId}`,
            );
          }
          return validateEvidence(this.#registry, item);
        });
        for (const item of validated) {
          const current = evidenceByComponent.get(item.componentId) ?? [];
          current.push(item);
          evidenceByComponent.set(item.componentId, current);
        }
        observerSnapshots.push({
          observerId: observer.id,
          status: "ok",
          observedAt: this.#now().toISOString(),
          evidenceCount: validated.length,
        });
      } catch (error) {
        observerSnapshots.push({
          observerId: observer.id,
          status: "failed",
          observedAt: this.#now().toISOString(),
          evidenceCount: 0,
          errorType: boundedErrorType(error),
        });
      }
    }

    const components = this.#registry.list().map((definition) =>
      buildComponentSnapshot(definition.id, evidenceByComponent.get(definition.id) ?? []),
    );

    return {
      schemaVersion: SYSTEM_AWARENESS_SCHEMA_VERSION,
      generatedAt: this.#now().toISOString(),
      definitionFingerprint: this.#registry.fingerprint(),
      components,
      observers: observerSnapshots,
    };
  }
}

export function resolveSystemFact(
  fact: string,
  evidence: readonly SystemEvidence[],
): SystemFactSnapshot {
  if (evidence.length === 0) {
    return {
      fact,
      resolution: "unknown",
      confidence: "unknown",
      value: null,
      evidence: [],
    };
  }

  const latestBySource = new Map<string, SystemEvidence>();
  for (const item of evidence) {
    const previous = latestBySource.get(item.source.id);
    if (!previous || Date.parse(item.observedAt) >= Date.parse(previous.observedAt)) {
      latestBySource.set(item.source.id, item);
    }
  }
  const latest = [...latestBySource.values()];
  const highestRank = Math.max(...latest.map((item) => confidenceRank(item.confidence)));
  const strongest = latest.filter((item) => confidenceRank(item.confidence) === highestRank);
  const confidence = strongest[0]?.confidence ?? "unknown";
  const distinctValues = new Set(strongest.map((item) => canonicalJson(item.value)));
  const orderedEvidence = [...evidence].sort(compareEvidence);

  if (confidence === "unknown") {
    return {
      fact,
      resolution: "unknown",
      confidence: "unknown",
      value: null,
      evidence: orderedEvidence,
    };
  }
  if (distinctValues.size > 1) {
    return {
      fact,
      resolution: "conflict",
      confidence: "unknown",
      value: null,
      evidence: orderedEvidence,
    };
  }
  return {
    fact,
    resolution: "resolved",
    confidence,
    value: structuredClone(strongest[0]!.value),
    evidence: orderedEvidence,
  };
}

function buildComponentSnapshot(
  componentId: string,
  evidence: readonly SystemEvidence[],
): SystemComponentSnapshot {
  const facts = new Map<string, SystemEvidence[]>();
  for (const item of evidence) {
    const current = facts.get(item.fact) ?? [];
    current.push(item);
    facts.set(item.fact, current);
  }
  return {
    componentId,
    observed: evidence.length > 0,
    facts: [...facts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([fact, items]) => resolveSystemFact(fact, items)),
  };
}

function validateObservers(
  registry: SystemDefinitionRegistry,
  observers: readonly SystemObserver[],
): void {
  const ids = new Set<string>();
  for (const observer of observers) {
    if (!SOURCE_PATTERN.test(observer.id)) {
      throw new Error(`Invalid system observer id: ${observer.id}`);
    }
    if (ids.has(observer.id)) throw new Error(`Duplicate system observer id: ${observer.id}`);
    ids.add(observer.id);
    if (observer.componentIds.length === 0) {
      throw new Error(`System observer ${observer.id} must declare at least one component`);
    }
    for (const componentId of observer.componentIds) {
      if (!registry.has(componentId)) {
        throw new Error(`System observer ${observer.id} references unknown component ${componentId}`);
      }
    }
  }
}

function validateEvidence(
  registry: SystemDefinitionRegistry,
  input: SystemEvidence,
): SystemEvidence {
  if (!registry.has(input.componentId)) {
    throw new Error(`System evidence references unknown component ${input.componentId}`);
  }
  if (!FACT_PATTERN.test(input.fact)) throw new Error(`Invalid system evidence fact: ${input.fact}`);
  if (!SOURCE_PATTERN.test(input.source.id)) {
    throw new Error(`Invalid system evidence source: ${input.source.id}`);
  }
  if (!Number.isFinite(Date.parse(input.observedAt))) {
    throw new Error(`Invalid system evidence timestamp for ${input.componentId}/${input.fact}`);
  }
  if (input.reason && (
    input.reason.length > 160
    || /[\u0000-\u001F\u007F]/u.test(input.reason)
  )) {
    throw new Error(`Invalid system evidence reason for ${input.componentId}/${input.fact}`);
  }
  validateEvidenceValue(input.value, `${input.componentId}/${input.fact}`);
  return structuredClone(input);
}

function validateEvidenceValue(value: SystemEvidenceValue, path: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Non-finite system evidence number at ${path}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateEvidenceValue(item, `${path}[${String(index)}]`));
    return;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`Non-plain system evidence object at ${path}`);
    }
    for (const [key, item] of Object.entries(value)) {
      if (!key || /[\u0000-\u001F\u007F]/u.test(key)) {
        throw new Error(`Invalid system evidence key at ${path}`);
      }
      validateEvidenceValue(item, `${path}.${key}`);
    }
    return;
  }
  throw new Error(`Unsupported system evidence value at ${path}`);
}

function confidenceRank(value: SystemEvidenceConfidence): number {
  if (value === "authoritative") return 3;
  if (value === "observed") return 2;
  if (value === "inferred") return 1;
  return 0;
}

function compareEvidence(left: SystemEvidence, right: SystemEvidence): number {
  const time = Date.parse(right.observedAt) - Date.parse(left.observedAt);
  if (time !== 0) return time;
  const confidence = confidenceRank(right.confidence) - confidenceRank(left.confidence);
  if (confidence !== 0) return confidence;
  return left.source.id.localeCompare(right.source.id);
}

function canonicalJson(value: SystemEvidenceValue): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: SystemEvidenceValue): SystemEvidenceValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const record = value as Readonly<Record<string, SystemEvidenceValue>>;
  const output: Record<string, SystemEvidenceValue> = {};
  for (const key of Object.keys(record).sort()) output[key] = canonicalize(record[key]!);
  return output;
}

function boundedErrorType(error: unknown): string {
  const name = error instanceof Error && error.name.trim() ? error.name : "Error";
  const bounded = name.replace(/[^A-Za-z0-9._:-]+/gu, "-").slice(0, 96);
  return bounded || "Error";
}
