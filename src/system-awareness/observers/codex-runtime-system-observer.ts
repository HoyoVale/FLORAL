import {
  supportsAgentExtensionDiscovery,
  supportsAgentSkills,
  type AgentAppSummary,
  type AgentMcpServerSummary,
  type AgentNativeFeatureSummary,
  type AgentRuntime,
  type AgentSkillSummary,
} from "../../core/contracts.js";
import type {
  SystemEvidence,
  SystemEvidenceValue,
  SystemObservationContext,
  SystemObserver,
} from "../system-types.js";
import { errorType, evidence, safeReason } from "./observer-utils.js";

const DEFAULT_MCP_COMPONENTS: Readonly<Record<string, string>> = {
  floral_search: "mcp.floral_search",
  floral_vision: "mcp.floral_vision",
  floral_peekaboo: "mcp.floral_peekaboo",
};

export interface CodexRuntimeSystemObserverOptions {
  runtime: AgentRuntime;
  now?: (() => Date) | undefined;
  mcpComponentByServerId?: Readonly<Record<string, string>> | undefined;
}

export class CodexRuntimeSystemObserver implements SystemObserver {
  readonly id = "codex-runtime";
  readonly componentIds = [
    "codex.runtime",
    "codex.skills",
    "codex.apps",
    "codex.mcp",
    "codex.plugins",
    "mcp.floral_search",
    "mcp.floral_vision",
    "mcp.floral_peekaboo",
  ] as const;

  readonly #runtime: AgentRuntime;
  readonly #now: () => Date;
  readonly #mcpComponentByServerId: Readonly<Record<string, string>>;

  constructor(options: CodexRuntimeSystemObserverOptions) {
    this.#runtime = options.runtime;
    this.#now = options.now ?? (() => new Date());
    this.#mcpComponentByServerId = options.mcpComponentByServerId ?? DEFAULT_MCP_COMPONENTS;
  }

  async observe(context: SystemObservationContext): Promise<readonly SystemEvidence[]> {
    const observedAt = this.#now().toISOString();
    const output: SystemEvidence[] = [runtimeEvidence("runtime_name", this.#runtime.name, observedAt)];
    const cwd = context.cwd?.trim();
    if (!cwd) {
      output.push(
        unknownRuntimeEvidence("codex.skills", "discovered", "codex-skills", observedAt, "cwd-required"),
        unknownRuntimeEvidence("codex.apps", "installed", "codex-app-installed", observedAt, "cwd-required"),
        unknownRuntimeEvidence("codex.apps", "callability", "codex-app-installed", observedAt, "cwd-required"),
        unknownRuntimeEvidence("codex.apps", "directory", "codex-app-directory", observedAt, "cwd-required"),
        unknownRuntimeEvidence("codex.mcp", "servers", "codex-mcp-status", observedAt, "cwd-required"),
        unknownRuntimeEvidence("codex.plugins", "features", "codex-native-features", observedAt, "cwd-required"),
      );
      this.#appendUnknownMcpComponents(output, observedAt, "cwd-required");
      return output;
    }

    await this.#observeSkills(cwd, observedAt, output);
    await this.#observeExtensions(cwd, context.threadId, observedAt, output);
    return output;
  }

  async #observeSkills(
    cwd: string,
    observedAt: string,
    output: SystemEvidence[],
  ): Promise<void> {
    if (!supportsAgentSkills(this.#runtime)) {
      output.push(
        unknownRuntimeEvidence(
          "codex.skills",
          "discovered",
          "codex-skills",
          observedAt,
          "runtime-skill-discovery-unsupported",
        ),
      );
      return;
    }
    try {
      const skills = await this.#runtime.listSkills({ cwd });
      output.push(evidence({
        componentId: "codex.skills",
        fact: "discovered",
        sourceId: "codex-skills",
        sourceKind: "runtime-rpc",
        confidence: "authoritative",
        scope: "project",
        value: skills.map(sanitizeSkill),
        observedAt,
      }));
    } catch (error) {
      output.push(
        unknownRuntimeEvidence(
          "codex.skills",
          "discovered",
          "codex-skills",
          observedAt,
          `runtime-error-${errorType(error)}`,
        ),
      );
    }
  }

  async #observeExtensions(
    cwd: string,
    threadId: string | undefined,
    observedAt: string,
    output: SystemEvidence[],
  ): Promise<void> {
    if (!supportsAgentExtensionDiscovery(this.#runtime)) {
      output.push(
        unknownRuntimeEvidence("codex.apps", "installed", "codex-app-installed", observedAt, "runtime-extension-discovery-unsupported"),
        unknownRuntimeEvidence("codex.apps", "callability", "codex-app-installed", observedAt, "runtime-extension-discovery-unsupported"),
        unknownRuntimeEvidence("codex.apps", "directory", "codex-app-directory", observedAt, "runtime-extension-discovery-unsupported"),
        unknownRuntimeEvidence("codex.mcp", "servers", "codex-mcp-status", observedAt, "runtime-extension-discovery-unsupported"),
        unknownRuntimeEvidence("codex.plugins", "features", "codex-native-features", observedAt, "runtime-extension-discovery-unsupported"),
      );
      this.#appendUnknownMcpComponents(output, observedAt, "runtime-extension-discovery-unsupported");
      return;
    }

    await this.#observeInstalledApps(cwd, threadId, observedAt, output);
    await this.#observeAvailableApps(cwd, threadId, observedAt, output);
    await this.#observeNativeFeatures(cwd, observedAt, output);
    await this.#observeMcp(cwd, threadId, observedAt, output);
  }

  async #observeInstalledApps(
    cwd: string,
    threadId: string | undefined,
    observedAt: string,
    output: SystemEvidence[],
  ): Promise<void> {
    try {
      const apps = await this.#runtimeAsExtensions().listInstalledApps({
        cwd,
        ...(threadId ? { threadId } : {}),
      });
      const runtimeApps = apps.filter((app) => app.source === "installed-runtime");
      const fallbackApps = apps.filter((app) => app.source === "directory-fallback");
      if (fallbackApps.length > 0) {
        output.push(
          unknownRuntimeEvidence(
            "codex.apps",
            "installed",
            "codex-app-installed",
            observedAt,
            "app-installed-unavailable",
          ),
          unknownRuntimeEvidence(
            "codex.apps",
            "callability",
            "codex-app-installed",
            observedAt,
            "app-installed-unavailable",
          ),
          evidence({
            componentId: "codex.apps",
            fact: "directory_fallback",
            sourceId: "codex-app-fallback",
            sourceKind: "runtime-rpc",
            confidence: "observed",
            scope: "runtime",
            value: fallbackApps.map(sanitizeApp),
            observedAt,
            reason: "app-installed-unavailable",
          }),
        );
        return;
      }

      output.push(
        evidence({
          componentId: "codex.apps",
          fact: "installed",
          sourceId: "codex-app-installed",
          sourceKind: "runtime-rpc",
          confidence: "authoritative",
          scope: "runtime",
          value: runtimeApps.map(sanitizeApp),
          observedAt,
        }),
        evidence({
          componentId: "codex.apps",
          fact: "callability",
          sourceId: "codex-app-installed",
          sourceKind: "runtime-rpc",
          confidence: "authoritative",
          scope: "runtime",
          value: callabilitySummary(runtimeApps),
          observedAt,
        }),
      );
    } catch (error) {
      const reason = `runtime-error-${errorType(error)}`;
      output.push(
        unknownRuntimeEvidence("codex.apps", "installed", "codex-app-installed", observedAt, reason),
        unknownRuntimeEvidence("codex.apps", "callability", "codex-app-installed", observedAt, reason),
      );
    }
  }

  async #observeAvailableApps(
    cwd: string,
    threadId: string | undefined,
    observedAt: string,
    output: SystemEvidence[],
  ): Promise<void> {
    try {
      const apps = await this.#runtimeAsExtensions().listAvailableApps({
        cwd,
        ...(threadId ? { threadId } : {}),
      });
      output.push(evidence({
        componentId: "codex.apps",
        fact: "directory",
        sourceId: "codex-app-directory",
        sourceKind: "runtime-rpc",
        confidence: "authoritative",
        scope: "runtime",
        value: apps.map(sanitizeApp),
        observedAt,
      }));
    } catch (error) {
      output.push(
        unknownRuntimeEvidence(
          "codex.apps",
          "directory",
          "codex-app-directory",
          observedAt,
          `runtime-error-${errorType(error)}`,
        ),
      );
    }
  }

  async #observeNativeFeatures(
    cwd: string,
    observedAt: string,
    output: SystemEvidence[],
  ): Promise<void> {
    try {
      const features = await this.#runtimeAsExtensions().listNativeExtensionFeatures({ cwd });
      output.push(evidence({
        componentId: "codex.plugins",
        fact: "features",
        sourceId: "codex-native-features",
        sourceKind: "runtime-rpc",
        confidence: "authoritative",
        scope: "runtime",
        value: features.map(sanitizeFeature),
        observedAt,
      }));
    } catch (error) {
      output.push(
        unknownRuntimeEvidence(
          "codex.plugins",
          "features",
          "codex-native-features",
          observedAt,
          `runtime-error-${errorType(error)}`,
        ),
      );
    }
  }

  async #observeMcp(
    cwd: string,
    threadId: string | undefined,
    observedAt: string,
    output: SystemEvidence[],
  ): Promise<void> {
    try {
      const servers = await this.#runtimeAsExtensions().listMcpServers({
        cwd,
        ...(threadId ? { threadId } : {}),
      });
      output.push(evidence({
        componentId: "codex.mcp",
        fact: "servers",
        sourceId: "codex-mcp-status",
        sourceKind: "runtime-rpc",
        confidence: "authoritative",
        scope: "runtime",
        value: servers.map(sanitizeMcpServer),
        observedAt,
      }));
      const reported = new Set<string>();
      for (const server of servers) {
        const componentId = this.#mcpComponentByServerId[server.name];
        if (!componentId) continue;
        reported.add(componentId);
        output.push(evidence({
          componentId,
          fact: "runtime",
          sourceId: "codex-mcp-status",
          sourceKind: "runtime-rpc",
          confidence: "authoritative",
          scope: "runtime",
          value: sanitizeMcpServer(server),
          observedAt,
        }));
      }
      for (const componentId of new Set(Object.values(this.#mcpComponentByServerId))) {
        if (reported.has(componentId)) continue;
        output.push(unknownRuntimeEvidence(
          componentId,
          "runtime",
          "codex-mcp-status",
          observedAt,
          "server-not-reported",
        ));
      }
    } catch (error) {
      const reason = `runtime-error-${errorType(error)}`;
      output.push(
        unknownRuntimeEvidence(
          "codex.mcp",
          "servers",
          "codex-mcp-status",
          observedAt,
          reason,
        ),
      );
      this.#appendUnknownMcpComponents(output, observedAt, reason);
    }
  }

  #appendUnknownMcpComponents(
    output: SystemEvidence[],
    observedAt: string,
    reason: string,
  ): void {
    for (const componentId of new Set(Object.values(this.#mcpComponentByServerId))) {
      output.push(unknownRuntimeEvidence(
        componentId,
        "runtime",
        "codex-mcp-status",
        observedAt,
        reason,
      ));
    }
  }

  #runtimeAsExtensions() {
    if (!supportsAgentExtensionDiscovery(this.#runtime)) {
      throw new Error("AgentExtensionDiscoveryUnsupported");
    }
    return this.#runtime;
  }
}

function runtimeEvidence(
  fact: string,
  value: SystemEvidenceValue,
  observedAt: string,
): SystemEvidence {
  return evidence({
    componentId: "codex.runtime",
    fact,
    sourceId: "codex-runtime",
    sourceKind: "runtime-rpc",
    confidence: "observed",
    scope: "runtime",
    value,
    observedAt,
  });
}

function unknownRuntimeEvidence(
  componentId: string,
  fact: string,
  sourceId: string,
  observedAt: string,
  reason: string,
): SystemEvidence {
  return evidence({
    componentId,
    fact,
    sourceId,
    sourceKind: "runtime-rpc",
    confidence: "unknown",
    scope: "runtime",
    value: null,
    observedAt,
    reason,
  });
}

function sanitizeSkill(skill: AgentSkillSummary): SystemEvidenceValue {
  return {
    name: skill.name,
    description: skill.description,
    scope: skill.scope,
    enabled: skill.enabled,
  };
}

function sanitizeApp(app: AgentAppSummary): SystemEvidenceValue {
  return {
    id: app.id,
    runtimeName: app.runtimeName ?? null,
    enabled: app.enabled,
    callable: app.callable ?? null,
    accessible: app.accessible ?? null,
    installSupported: Boolean(app.installUrl),
    source: app.source,
  };
}

function callabilitySummary(apps: AgentAppSummary[]): SystemEvidenceValue {
  const known = apps.filter((app) => app.callable !== undefined);
  return {
    installed: apps.length,
    known: known.length,
    callable: known.filter((app) => app.callable === true).length,
    notCallable: known.filter((app) => app.callable === false).length,
    unknown: apps.length - known.length,
  };
}

function sanitizeFeature(feature: AgentNativeFeatureSummary): SystemEvidenceValue {
  return {
    name: feature.name,
    stage: feature.stage,
    enabled: feature.enabled,
    defaultEnabled: feature.defaultEnabled,
  };
}

function sanitizeMcpServer(server: AgentMcpServerSummary): SystemEvidenceValue {
  return {
    name: server.name,
    status: server.status,
    authStatus: server.authStatus ?? null,
    failureReason: server.failureReason ? safeReason(server.failureReason) : null,
    tools: server.tools.map((tool) => ({
      name: tool.name,
      readOnly: tool.readOnly ?? null,
    })),
  };
}
