import { SystemDefinitionRegistry } from "./system-definition-registry.js";
import type {
  ManagementActionDefinition,
  SystemComponentSnapshot,
  SystemDefinition,
  SystemEvidence,
  SystemEvidenceValue,
  SystemFactSnapshot,
  SystemObservationContext,
  SystemSnapshot,
} from "./system-types.js";
import type { SystemSnapshotBuilder } from "./system-snapshot-builder.js";

const MAX_SUMMARY_LENGTH = 12_000;
const MAX_COMPONENT_LENGTH = 12_000;
const MAX_CAPABILITY_LENGTH = 12_000;
const MAX_VALUE_LENGTH = 1_600;

export interface SystemReadModel {
  definitions: readonly SystemDefinition[];
  snapshot: SystemSnapshot;
}

export interface SystemAwarenessReadProvider {
  read(context?: SystemObservationContext): Promise<SystemReadModel>;
}

export class SystemAwarenessReader implements SystemAwarenessReadProvider {
  readonly #registry: SystemDefinitionRegistry;
  readonly #builder: SystemSnapshotBuilder;

  constructor(registry: SystemDefinitionRegistry, builder: SystemSnapshotBuilder) {
    this.#registry = registry;
    this.#builder = builder;
  }

  async read(context: SystemObservationContext = {}): Promise<SystemReadModel> {
    const snapshot = await this.#builder.build(context);
    const fingerprint = this.#registry.fingerprint();
    if (snapshot.definitionFingerprint !== fingerprint) {
      throw new Error("System awareness definition fingerprint mismatch");
    }
    return {
      definitions: this.#registry.list(),
      snapshot,
    };
  }
}

export function validateSystemReadModel(model: SystemReadModel): SystemDefinitionRegistry {
  const registry = new SystemDefinitionRegistry(model.definitions);
  if (model.snapshot.definitionFingerprint !== registry.fingerprint()) {
    throw new Error("System read model definition fingerprint mismatch");
  }
  return registry;
}

export function formatSystemSummary(model: SystemReadModel): string {
  const registry = validateSystemReadModel(model);
  const byComponent = new Map(
    model.snapshot.components.map((component) => [component.componentId, component] as const),
  );
  let observed = 0;
  let resolvedFacts = 0;
  let unknownFacts = 0;
  let conflictFacts = 0;
  const lines = [
    "FLORAL System Awareness",
    `schema_version=${String(model.snapshot.schemaVersion)}`,
    `generated_at=${model.snapshot.generatedAt}`,
    `definition_fingerprint=${model.snapshot.definitionFingerprint}`,
    `components=${String(model.definitions.length)}`,
  ];

  for (const definition of registry.list()) {
    const component = byComponent.get(definition.id);
    if (component?.observed) observed += 1;
    const facts = materializeComponentFacts(definition, component);
    for (const fact of facts) {
      if (fact.resolution === "resolved") resolvedFacts += 1;
      else if (fact.resolution === "conflict") conflictFacts += 1;
      else unknownFacts += 1;
    }
    lines.push([
      `component=${definition.id}`,
      `kind=${definition.kind}`,
      `observed=${String(component?.observed === true)}`,
      `resolved=${String(facts.filter((fact) => fact.resolution === "resolved").length)}`,
      `unknown=${String(facts.filter((fact) => fact.resolution === "unknown").length)}`,
      `conflict=${String(facts.filter((fact) => fact.resolution === "conflict").length)}`,
    ].join(" "));
  }

  const failedObservers = model.snapshot.observers.filter((observer) => observer.status === "failed");
  lines.splice(5, 0,
    `observed_components=${String(observed)}/${String(model.definitions.length)}`,
    `facts_resolved=${String(resolvedFacts)}`,
    `facts_unknown=${String(unknownFacts)}`,
    `facts_conflict=${String(conflictFacts)}`,
    `observers=${String(model.snapshot.observers.length)} failed=${String(failedObservers.length)}`,
  );
  for (const observer of model.snapshot.observers) {
    lines.push([
      `observer=${observer.observerId}`,
      `status=${observer.status}`,
      `evidence=${String(observer.evidenceCount)}`,
      `observed_at=${observer.observedAt}`,
      ...(observer.errorType ? [`error_type=${safeToken(observer.errorType)}`] : []),
    ].join(" "));
  }
  lines.push(
    "snapshot_semantics=read-only-per-turn-frozen",
    "unknown_semantics=unknown-is-a-valid-state-and-must-not-be-upgraded-by-guessing",
    "management_semantics=declared-actions-are-contract-metadata-not-execution-or-authorization",
  );
  return boundedText(lines.join("\n"), MAX_SUMMARY_LENGTH);
}

export function formatSystemComponentStatus(
  model: SystemReadModel,
  componentId: string,
): string {
  const registry = validateSystemReadModel(model);
  const normalized = componentId.trim();
  const definition = registry.get(normalized);
  if (!definition) {
    throw new Error(`Unknown system component id: ${normalized || "empty"}`);
  }
  const component = model.snapshot.components.find((entry) => entry.componentId === normalized);
  const facts = materializeComponentFacts(definition, component);
  const lines = [
    "FLORAL System Component",
    `component=${definition.id}`,
    `display_name=${JSON.stringify(definition.displayName)}`,
    `kind=${definition.kind}`,
    `observed=${String(component?.observed === true)}`,
    `owner_party=${definition.owner.party}`,
    `owner_name=${JSON.stringify(definition.owner.name)}`,
    `owner_responsibility=${JSON.stringify(definition.owner.responsibility)}`,
    `authority_party=${definition.authority.party}`,
    `authority_name=${JSON.stringify(definition.authority.name)}`,
    `authority_responsibility=${JSON.stringify(definition.authority.responsibility)}`,
    `failure_domain=${definition.failureDomain}`,
    `parent=${definition.parentId ?? "none"}`,
    `tags=${JSON.stringify(definition.tags)}`,
    `secret_dependencies=${JSON.stringify(definition.secretDependencies)}`,
    `management_actions=${String(definition.managementActions.length)}`,
    `generated_at=${model.snapshot.generatedAt}`,
  ];

  for (const fact of facts) {
    lines.push([
      `fact=${fact.fact}`,
      `resolution=${fact.resolution}`,
      `confidence=${fact.confidence}`,
      `value=${formatValue(fact.value)}`,
      `evidence=${String(fact.evidence.length)}`,
    ].join(" "));
    for (const item of fact.evidence) {
      lines.push(formatEvidenceLine(fact.fact, item));
    }
  }

  if (facts.length === 0) {
    lines.push("facts=none");
  }
  lines.push(
    "snapshot_semantics=read-only-per-turn-frozen",
    "secret_semantics=dependency-and-presence-metadata-only-never-secret-values",
  );
  return boundedText(lines.join("\n"), MAX_COMPONENT_LENGTH);
}

export function formatSystemCapabilities(
  model: SystemReadModel,
  componentId?: string | undefined,
): string {
  const registry = validateSystemReadModel(model);
  const normalized = componentId?.trim();
  const definitions = normalized ? [registry.require(normalized)] : registry.list();
  const lines = [
    "FLORAL System Management Surface",
    `generated_at=${model.snapshot.generatedAt}`,
    `scope=${normalized ?? "all"}`,
    "read_only=true",
    "authorization_granted=false",
    "execution_performed=false",
  ];

  let count = 0;
  for (const definition of definitions) {
    for (const action of definition.managementActions) {
      count += 1;
      lines.push(formatManagementAction(definition, action));
    }
  }
  lines.splice(3, 0, `declared_actions=${String(count)}`);
  if (count === 0) lines.push("actions=none");
  lines.push(
    "semantics=management-actions-describe-the-governed-contract-only",
    "next_step=self-maintenance-is-not-enabled-by-this-interface",
  );
  return boundedText(lines.join("\n"), MAX_CAPABILITY_LENGTH);
}

function materializeComponentFacts(
  definition: SystemDefinition,
  component: SystemComponentSnapshot | undefined,
): SystemFactSnapshot[] {
  const observedByFact = new Map(
    (component?.facts ?? []).map((fact) => [fact.fact, fact] as const),
  );
  const factNames = new Set<string>();
  for (const source of definition.stateSources) {
    for (const fact of source.facts) factNames.add(fact);
  }
  for (const fact of component?.facts ?? []) factNames.add(fact.fact);
  return [...factNames]
    .sort((left, right) => left.localeCompare(right))
    .map((fact) => observedByFact.get(fact) ?? ({
      fact,
      resolution: "unknown" as const,
      confidence: "unknown" as const,
      value: null,
      evidence: [],
    }));
}

function formatEvidenceLine(fact: string, item: SystemEvidence): string {
  return [
    `evidence_for=${fact}`,
    `source=${item.source.id}`,
    `kind=${item.source.kind}`,
    `confidence=${item.confidence}`,
    `scope=${item.scope}`,
    `observed_at=${item.observedAt}`,
    ...(item.reason ? [`reason=${safeToken(item.reason)}`] : []),
  ].join(" ");
}

function formatManagementAction(
  definition: SystemDefinition,
  action: ManagementActionDefinition,
): string {
  return [
    `component=${definition.id}`,
    `action=${action.id}`,
    `disposition=${action.disposition}`,
    `approval=${action.approval}`,
    `capability=${action.capability ?? "none"}`,
    `executor=${action.executor ?? "none"}`,
    `verification=${action.verification ?? "none"}`,
  ].join(" ");
}

function formatValue(value: SystemEvidenceValue): string {
  const serialized = JSON.stringify(value);
  if (serialized.length <= MAX_VALUE_LENGTH) return serialized;
  return `${serialized.slice(0, MAX_VALUE_LENGTH - 20)}...<truncated>`;
}

function boundedText(value: string, maxLength: number): string {
  const normalized = value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, " ")
    .trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 20)}\ntruncated=true`;
}

function safeToken(value: string): string {
  const normalized = value
    .replace(/[^A-Za-z0-9._:/-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 160);
  return normalized || "unknown";
}
