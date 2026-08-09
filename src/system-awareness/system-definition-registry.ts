import { createHash } from "node:crypto";
import {
  SYSTEM_AWARENESS_SCHEMA_VERSION,
  type ManagementActionDefinition,
  type SystemDefinition,
  type SystemStateSourceDefinition,
} from "./system-types.js";

const COMPONENT_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const TOKEN_PATTERN = /^[a-z][a-z0-9]*(?:[._:/-][a-z0-9]+)*$/u;
const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/u;

export class SystemDefinitionRegistry {
  readonly #definitions = new Map<string, SystemDefinition>();

  constructor(definitions: readonly SystemDefinition[] = []) {
    for (const definition of definitions) this.register(definition, false);
    this.#validateParentReferences();
  }

  register(definition: SystemDefinition, validateParents = true): void {
    validateSystemDefinition(definition);
    if (this.#definitions.has(definition.id)) {
      throw new Error(`Duplicate system definition id: ${definition.id}`);
    }
    if (validateParents && definition.parentId && !this.#definitions.has(definition.parentId)) {
      throw new Error(
        `System definition ${definition.id} references unknown parent ${definition.parentId}`,
      );
    }
    this.#definitions.set(definition.id, structuredClone(definition));
  }

  has(id: string): boolean {
    return this.#definitions.has(id);
  }

  get(id: string): SystemDefinition | undefined {
    const definition = this.#definitions.get(id);
    return definition ? structuredClone(definition) : undefined;
  }

  require(id: string): SystemDefinition {
    const definition = this.get(id);
    if (!definition) throw new Error(`Unknown system definition id: ${id}`);
    return definition;
  }

  list(): SystemDefinition[] {
    return [...this.#definitions.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((definition) => structuredClone(definition));
  }

  fingerprint(): string {
    return createHash("sha256")
      .update(JSON.stringify(this.list()), "utf8")
      .digest("hex");
  }

  #validateParentReferences(): void {
    for (const definition of this.#definitions.values()) {
      if (definition.parentId && !this.#definitions.has(definition.parentId)) {
        throw new Error(
          `System definition ${definition.id} references unknown parent ${definition.parentId}`,
        );
      }
    }
  }
}

export function validateSystemDefinition(definition: SystemDefinition): void {
  if (definition.schemaVersion !== SYSTEM_AWARENESS_SCHEMA_VERSION) {
    throw new Error(`Unsupported system definition schema: ${String(definition.schemaVersion)}`);
  }
  requireComponentId(definition.id, "system definition id");
  requireText(definition.displayName, "displayName");
  requireText(definition.description, "description");
  requireText(definition.owner.name, "owner.name");
  requireText(definition.owner.responsibility, "owner.responsibility");
  requireText(definition.authority.name, "authority.name");
  requireText(definition.authority.responsibility, "authority.responsibility");
  if (definition.parentId) requireComponentId(definition.parentId, "parentId");

  const sourceIds = new Set<string>();
  for (const source of definition.stateSources) {
    validateStateSource(source);
    if (sourceIds.has(source.id)) {
      throw new Error(`Duplicate state source id for ${definition.id}: ${source.id}`);
    }
    sourceIds.add(source.id);
  }

  const actionIds = new Set<string>();
  for (const action of definition.managementActions) {
    validateManagementAction(action);
    if (actionIds.has(action.id)) {
      throw new Error(`Duplicate management action for ${definition.id}: ${action.id}`);
    }
    actionIds.add(action.id);
  }

  for (const secret of definition.secretDependencies) {
    if (!SECRET_NAME_PATTERN.test(secret)) {
      throw new Error(`Invalid secret dependency for ${definition.id}: ${secret}`);
    }
  }
  if (new Set(definition.secretDependencies).size !== definition.secretDependencies.length) {
    throw new Error(`Duplicate secret dependency for ${definition.id}`);
  }
  for (const tag of definition.tags) requireToken(tag, `tag for ${definition.id}`);
}

function validateStateSource(source: SystemStateSourceDefinition): void {
  requireToken(source.id, "state source id");
  requireText(source.description, "state source description");
  if (source.facts.length === 0) {
    throw new Error(`State source ${source.id} must declare at least one fact`);
  }
  const facts = new Set<string>();
  for (const fact of source.facts) {
    requireToken(fact, `fact for state source ${source.id}`);
    if (facts.has(fact)) throw new Error(`Duplicate fact in state source ${source.id}: ${fact}`);
    facts.add(fact);
  }
}

function validateManagementAction(action: ManagementActionDefinition): void {
  requireToken(action.id, "management action id");
  requireText(action.description, "management action description");
  if (action.executor) requireToken(action.executor, `executor for ${action.id}`);
  if (action.verification) requireToken(action.verification, `verification for ${action.id}`);
  if (action.notes) requireText(action.notes, `notes for ${action.id}`);
}

function requireComponentId(value: string, label: string): void {
  if (!COMPONENT_ID_PATTERN.test(value)) throw new Error(`Invalid ${label}: ${value}`);
}

function requireToken(value: string, label: string): void {
  if (!TOKEN_PATTERN.test(value)) throw new Error(`Invalid ${label}: ${value}`);
}

function requireText(value: string, label: string): void {
  if (!value.trim() || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
}
