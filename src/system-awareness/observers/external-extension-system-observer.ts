import {
  CURATED_EXTERNAL_MCP,
  readExternalMcpRegistry,
  resolveExternalMcpRegistryPaths,
} from "../../extensions/external-mcp-registry.js";
import {
  readExternalSkillRegistry,
  resolveExternalSkillRegistryPaths,
} from "../../skills/external-skill-registry.js";
import type {
  SystemEvidence,
  SystemObservationContext,
  SystemObserver,
} from "../system-types.js";
import { errorType, evidence } from "./observer-utils.js";

export interface ExternalExtensionSystemObserverOptions {
  repositoryRoot: string;
  dataDir: string;
  environment?: NodeJS.ProcessEnv | undefined;
  now?: (() => Date) | undefined;
}

export class ExternalExtensionSystemObserver implements SystemObserver {
  readonly id = "external-extension-registry";
  readonly componentIds = [
    "extensions.external_skills",
    "extensions.external_mcp",
  ] as const;

  readonly #repositoryRoot: string;
  readonly #dataDir: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #now: () => Date;

  constructor(options: ExternalExtensionSystemObserverOptions) {
    this.#repositoryRoot = options.repositoryRoot;
    this.#dataDir = options.dataDir;
    this.#environment = options.environment ?? process.env;
    this.#now = options.now ?? (() => new Date());
  }

  async observe(_context: SystemObservationContext): Promise<readonly SystemEvidence[]> {
    const observedAt = this.#now().toISOString();
    const output: SystemEvidence[] = [];
    await this.#observeSkills(observedAt, output);
    await this.#observeMcp(observedAt, output);
    return output;
  }

  async #observeSkills(observedAt: string, output: SystemEvidence[]): Promise<void> {
    try {
      const registry = await readExternalSkillRegistry(
        resolveExternalSkillRegistryPaths(this.#repositoryRoot, this.#dataDir),
      );
      output.push(evidence({
        componentId: "extensions.external_skills",
        fact: "packages",
        sourceId: "external-skill-registry",
        sourceKind: "registry",
        confidence: "authoritative",
        scope: "machine",
        value: registry.packages.map((entry) => ({
          id: entry.id,
          ref: entry.ref,
          commit: entry.commit,
          enabled: entry.enabled,
          skillSubdir: entry.skillSubdir,
          installedAt: entry.installedAt,
          updatedAt: entry.updatedAt,
        })),
        observedAt,
      }));
    } catch (error) {
      output.push(evidence({
        componentId: "extensions.external_skills",
        fact: "packages",
        sourceId: "external-skill-registry",
        sourceKind: "registry",
        confidence: "unknown",
        scope: "machine",
        value: null,
        observedAt,
        reason: `registry-error-${errorType(error)}`,
      }));
    }
  }

  async #observeMcp(observedAt: string, output: SystemEvidence[]): Promise<void> {
    try {
      const registry = await readExternalMcpRegistry(
        resolveExternalMcpRegistryPaths(this.#repositoryRoot, this.#dataDir),
      );
      output.push(evidence({
        componentId: "extensions.external_mcp",
        fact: "packages",
        sourceId: "external-mcp-registry",
        sourceKind: "registry",
        confidence: "authoritative",
        scope: "machine",
        value: registry.packages.map((entry) => ({
          id: entry.id,
          serverId: CURATED_EXTERNAL_MCP[entry.id].serverId,
          enabled: entry.enabled,
          installedAt: entry.installedAt,
          updatedAt: entry.updatedAt,
        })),
        observedAt,
      }));

      const authPresence = registry.packages
        .map((entry) => {
          const catalog = CURATED_EXTERNAL_MCP[entry.id];
          const envName = catalog.authEnvVar;
          return {
            id: entry.id,
            serverId: catalog.serverId,
            requirement: catalog.authentication,
            env: envName ?? null,
            present: envName ? hasNonEmptyEnvironmentValue(this.#environment, envName) : true,
          };
        })
        .sort((left, right) => left.id.localeCompare(right.id));
      output.push(evidence({
        componentId: "extensions.external_mcp",
        fact: "auth_presence",
        sourceId: "external-mcp-auth",
        sourceKind: "environment",
        confidence: "authoritative",
        scope: "machine",
        value: authPresence,
        observedAt,
      }));
    } catch (error) {
      const reason = `registry-error-${errorType(error)}`;
      output.push(
        evidence({
          componentId: "extensions.external_mcp",
          fact: "packages",
          sourceId: "external-mcp-registry",
          sourceKind: "registry",
          confidence: "unknown",
          scope: "machine",
          value: null,
          observedAt,
          reason,
        }),
        evidence({
          componentId: "extensions.external_mcp",
          fact: "auth_presence",
          sourceId: "external-mcp-auth",
          sourceKind: "environment",
          confidence: "unknown",
          scope: "machine",
          value: null,
          observedAt,
          reason,
        }),
      );
    }
  }
}

function hasNonEmptyEnvironmentValue(environment: NodeJS.ProcessEnv, name: string): boolean {
  const value = environment[name];
  return typeof value === "string" && value.trim().length > 0;
}
