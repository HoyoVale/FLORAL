import type { AppEnv } from "../../config/env.js";
import {
  resolveEffectiveChatTransport,
  type ResolvedConfigurationAuthority,
} from "../../config/federation/config-authority.js";
import { buildMcpRuntimeRegistry } from "../../config/mcp/mcp-runtime-registry.js";
import type {
  SystemEvidence,
  SystemEvidenceValue,
  SystemObservationContext,
  SystemObserver,
} from "../system-types.js";
import { evidence } from "./observer-utils.js";

export interface ConfigurationSystemObserverOptions {
  authority: ResolvedConfigurationAuthority;
  env: AppEnv;
  now?: (() => Date) | undefined;
}

export class ConfigurationSystemObserver implements SystemObserver {
  readonly id = "configuration-system";
  readonly componentIds = [
    "floral.configuration",
    "floral.authorization",
    "floral.workspace",
    "floral.storage",
    "codex.runtime",
    "codex.mcp",
    "deepseek.provider",
    "search.searxng",
    "mcp.floral_search",
    "mcp.floral_vision",
    "mcp.floral_peekaboo",
    "transport.feishu",
    "transport.qq",
  ] as const;

  readonly #authority: ResolvedConfigurationAuthority;
  readonly #env: AppEnv;
  readonly #now: () => Date;

  constructor(options: ConfigurationSystemObserverOptions) {
    this.#authority = options.authority;
    this.#env = options.env;
    this.#now = options.now ?? (() => new Date());
  }

  async observe(_context: SystemObservationContext): Promise<readonly SystemEvidence[]> {
    const observedAt = this.#now().toISOString();
    const config = this.#authority.effective;
    const registry = buildMcpRuntimeRegistry(config);
    const secretPresence: Record<string, SystemEvidenceValue> = {};
    for (const [id, ref] of Object.entries(config.secrets).sort(([left], [right]) => left.localeCompare(right))) {
      secretPresence[id] = {
        kind: ref.kind,
        name: ref.name,
        present: ref.present,
      };
    }

    const configuredServers = registry.servers
      .map((server) => ({
        id: server.id,
        enabled: server.enabled,
        integrationStatus: server.integrationStatus,
        required: server.required ?? false,
        tools: server.tools
          .filter((tool) => tool.enabled)
          .map((tool) => ({ name: tool.name, approvalMode: tool.approvalMode }))
          .sort((left, right) => left.name.localeCompare(right.name)),
      }))
      .sort((left, right) => left.id.localeCompare(right.id));

    const output: SystemEvidence[] = [
      configEvidence("floral.configuration", "profile", config.profile, observedAt),
      configEvidence("floral.configuration", "requested_fingerprint", this.#authority.requestedFingerprint, observedAt),
      configEvidence("floral.configuration", "effective_fingerprint", this.#authority.effectiveFingerprint, observedAt),
      configEvidence("floral.configuration", "environment_overrides", [...this.#authority.environmentOverrideKeys], observedAt),
      configEvidence("floral.configuration", "locked_paths", [...this.#authority.lockedPaths], observedAt),
      configEvidence("floral.configuration", "secret_presence", secretPresence, observedAt),
      configEvidence("floral.authorization", "enabled", config.runtime.authorization.enabled, observedAt),
      configEvidence("floral.authorization", "sandbox_mode", config.runtime.authorization.codex_turn_sandbox_mode, observedAt),
      configEvidence("floral.authorization", "owner_only_remote_approval", config.runtime.authorization.owner_only_remote_approval, observedAt),
      configEvidence("floral.authorization", "codex_turn_approval_policy", config.runtime.authorization.codex_turn_approval_policy, observedAt),
      environmentEvidence("floral.authorization", "remote_mode_ceiling", this.#env.FLORAL_REMOTE_MODE_CEILING, observedAt),
      environmentEvidence("floral.workspace", "workspace_root_configured", Boolean(this.#env.FLORAL_WORKSPACE_ROOT), observedAt),
      configEvidence("floral.storage", "configured", true, observedAt),
      configEvidence("codex.runtime", "configured_mode", config.codex.mode, observedAt),
      configEvidence("codex.runtime", "configured_model", config.codex.model || config.deepseek.model, observedAt),
      configEvidence("codex.runtime", "configured_sandbox", config.codex.sandbox.mode, observedAt),
      configEvidence("codex.runtime", "configured_approval", config.codex.approval.policy, observedAt),
      configEvidence("codex.mcp", "configured_servers", configuredServers, observedAt, "floral-mcp-registry"),
      configEvidence("deepseek.provider", "configured_model", config.deepseek.model, observedAt),
      configEvidence("deepseek.provider", "configured_endpoint", config.deepseek.base_url, observedAt),
      configEvidence("deepseek.provider", "credential_present", config.secrets.deepseek_api_key.present, observedAt),
      configEvidence("search.searxng", "configured_endpoint", config.search.service_url, observedAt),
      configEvidence("transport.feishu", "configured_mode", resolveEffectiveChatTransport(config) === "feishu" ? "selected" : "standby", observedAt),
      configEvidence("transport.feishu", "credential_presence", {
        appId: config.secrets.feishu_app_id.present,
        appSecret: config.secrets.feishu_app_secret.present,
      }, observedAt),
      configEvidence("transport.qq", "configured_mode", config.qq.mode, observedAt),
      configEvidence("transport.qq", "credential_presence", {
        appId: config.secrets.qq_app_id.present,
        appSecret: config.secrets.qq_app_secret.present,
      }, observedAt),
    ];

    const componentByServerId: Readonly<Record<string, string>> = {
      [config.mcp.search.id]: "mcp.floral_search",
      [config.mcp.vision.id]: "mcp.floral_vision",
      [config.mcp.macos.id]: "mcp.floral_peekaboo",
    };
    for (const server of configuredServers) {
      const componentId = componentByServerId[server.id];
      if (!componentId) continue;
      output.push(configEvidence(componentId, "configured", server, observedAt, "floral-mcp-registry"));
    }

    return output;
  }
}

function configEvidence(
  componentId: string,
  fact: string,
  value: SystemEvidenceValue,
  observedAt: string,
  sourceId = "configuration-authority",
): SystemEvidence {
  return evidence({
    componentId,
    fact,
    sourceId,
    sourceKind: "configuration",
    confidence: "authoritative",
    scope: "process",
    value,
    observedAt,
  });
}

function environmentEvidence(
  componentId: string,
  fact: string,
  value: SystemEvidenceValue,
  observedAt: string,
): SystemEvidence {
  return evidence({
    componentId,
    fact,
    sourceId: "machine-policy",
    sourceKind: "environment",
    confidence: "authoritative",
    scope: "machine",
    value,
    observedAt,
  });
}
