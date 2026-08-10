import { SystemDefinitionRegistry } from "./system-definition-registry.js";
import {
  SYSTEM_AWARENESS_SCHEMA_VERSION,
  type ManagementActionDefinition,
  type SystemAuthorityParty,
  type SystemDefinition,
  type SystemEvidenceSourceKind,
  type SystemFailureDomain,
  type SystemStateSourceDefinition,
} from "./system-types.js";

export function createDefaultSystemDefinitionRegistry(): SystemDefinitionRegistry {
  return new SystemDefinitionRegistry(DEFAULT_SYSTEM_DEFINITIONS);
}

export const DEFAULT_SYSTEM_DEFINITIONS: readonly SystemDefinition[] = [
  definition({
    id: "floral.service",
    displayName: "FLORAL Service",
    description: "The FLORAL gateway process and its machine-local service lifecycle wrapper.",
    kind: "service",
    owner: authority("floral", "FLORAL", "Owns gateway process behavior and bounded service metadata."),
    authority: authority("macos", "macOS service layer", "Owns LaunchAgent process lifecycle and host process state."),
    stateSources: [
      source("service-state", "filesystem", "authoritative", ["recorded.present", "recorded.phase", "recorded.pid", "recorded.updated_at"], "FLORAL's bounded service-state.json record."),
      source("process-liveness", "process", "observational", ["process.alive"], "Host process liveness check for the recorded PID."),
    ],
    managementActions: [
      action("read", "Read service state and liveness evidence.", "automatic", "automatic", "machine.status.read"),
      action("restart", "Restart the LaunchAgent-backed FLORAL service through the bounded maintenance handoff worker.", "host-only", "autonomy-policy", "system.restart", "system-maintenance/service-restart-worker", "maintenance-receipt"),
    ],
    failureDomain: "host",
    tags: ["control-plane", "service"],
  }),
  definition({
    id: "floral.maintenance",
    displayName: "FLORAL Maintenance Ledger",
    description: "Machine-bounded maintenance autonomy policy plus bounded receipts for governed self-maintenance actions and post-action verification.",
    kind: "runtime",
    owner: authority("floral", "FLORAL", "Owns maintenance transaction recording and verification receipts."),
    authority: authority("floral", "SystemMaintenanceController", "Is authoritative for maintenance autonomy state, queued handoff, circuit-breaker state, and worker verification receipts."),
    parentId: "floral.service",
    stateSources: [
      source("maintenance-receipt", "filesystem", "authoritative", ["last_transaction"], "Latest bounded system-maintenance transaction receipt; contains no command text or secrets."),
      source("maintenance-autonomy-policy", "filesystem", "authoritative", ["autonomy_policy", "autonomy_state"], "Machine-bounded maintenance autonomy mode, rate limits, cooldown, and circuit-breaker state."),
    ],
    managementActions: [
      action("read", "Read the latest governed maintenance receipt.", "automatic", "automatic", "machine.status.read"),
    ],
    failureDomain: "floral",
    tags: ["control-plane", "maintenance", "audit"],
  }),
  definition({
    id: "floral.extension_control",
    displayName: "FLORAL Extension Control Ledger",
    description: "Machine-local receipts for governed External MCP/Skill mutations and upstream App installation handoffs, plus fresh-turn verification state.",
    kind: "runtime",
    owner: authority("floral", "FLORAL", "Owns bounded extension-control planning, lifecycle handoff receipts, and verification records."),
    authority: authority("floral", "ExtensionControlLedger", "Is authoritative for the latest FLORAL-controlled extension transaction receipt; runtime readiness remains authoritative in the owning extension/runtime observers."),
    stateSources: [
      source("extension-control-ledger", "filesystem", "authoritative", ["last_transaction"], "Latest bounded controlled-extension transaction receipt; contains no credential values, shell commands, arbitrary package sources, or authentication tokens."),
    ],
    managementActions: [
      action("read", "Read the latest controlled-extension receipt.", "automatic", "automatic", "machine.status.read"),
    ],
    failureDomain: "floral",
    tags: ["control-plane", "extension", "audit"],
  }),
  definition({
    id: "floral.configuration",
    displayName: "Configuration Authority",
    description: "Resolved requested/effective FLORAL configuration, provenance, locked paths, and secret references.",
    kind: "configuration",
    owner: authority("floral", "FLORAL", "Defines typed configuration schema, federation, provenance, and rendering boundaries."),
    authority: authority("floral", "ConfigurationAuthority", "Is authoritative for requested/effective FLORAL configuration facts."),
    stateSources: [
      source("configuration-authority", "configuration", "authoritative", ["profile", "requested_fingerprint", "effective_fingerprint", "environment_overrides", "locked_paths", "secret_presence"], "Resolved ConfigurationAuthority object; secret values are never included."),
    ],
    managementActions: [
      action("read", "Read requested/effective configuration metadata and provenance.", "automatic", "automatic", "machine.status.read"),
      action("update", "Change configuration only through typed source/configuration workflows, not generic Agent mutation.", "source-change", "source-change", undefined, "configuration-authority", "configuration-authority"),
    ],
    failureDomain: "floral",
    tags: ["authority", "configuration"],
  }),
  definition({
    id: "floral.authorization",
    displayName: "Authorization Authority",
    description: "FLORAL capability, role, sandbox-ceiling, and approval decision boundary.",
    kind: "policy",
    owner: authority("floral", "FLORAL policy layer", "Owns authorization and approval decisions outside Codex native execution policy."),
    authority: authority("floral", "AuthorizationAuthority", "Is authoritative for FLORAL capability decisions."),
    parentId: "floral.configuration",
    stateSources: [
      source("configuration-authority", "configuration", "authoritative", ["enabled", "sandbox_mode", "owner_only_remote_approval", "codex_turn_approval_policy"], "Effective authorization configuration."),
      source("machine-policy", "environment", "authoritative", ["remote_mode_ceiling"], "Machine-local execution ceiling that project config cannot raise."),
    ],
    managementActions: [
      action("read", "Read authorization policy and machine-local ceilings.", "automatic", "automatic", "machine.status.read"),
      action("update", "Change policy through trusted source/configuration workflows only.", "source-change", "source-change"),
    ],
    failureDomain: "floral",
    tags: ["authority", "policy", "security"],
  }),
  definition({
    id: "floral.execution",
    displayName: "FLORAL Execution Context",
    description: "Gateway-selected execution intent and the exact Codex turn policy selector used for the current request.",
    kind: "runtime",
    owner: authority("floral", "FLORAL Gateway", "Selects the per-conversation control mode and routes each Agent run into Codex."),
    authority: authority("floral", "FLORAL execution router", "Is authoritative for what FLORAL requested and which Codex permission selector it actually sent for the current turn."),
    parentId: "floral.authorization",
    stateSources: [
      source(
        "gateway-execution-policy",
        "runtime-context",
        "authoritative",
        [
          "gateway.control_mode",
          "gateway.requested_sandbox",
          "gateway.requested_approval_policy",
          "gateway.requested_approvals_reviewer",
          "gateway.approval_route",
        ],
        "Conversation-scoped mode selected by the FLORAL Gateway. These are requested turn controls, not proof of the final Codex permission selector.",
        "contextual",
      ),
      source(
        "codex-turn-execution",
        "runtime-context",
        "authoritative",
        [
          "turn.selector",
          "turn.sandbox_mode",
          "turn.permission_profile",
          "turn.approval_policy",
          "turn.approvals_reviewer",
        ],
        "Exact turn/start execution selector constructed by CodexAppServerRuntime before the current turn. A named permission profile takes precedence over legacy sandboxPolicy.",
        "contextual",
      ),
    ],
    managementActions: [
      action("read", "Read the current Gateway request and effective Codex turn selector.", "automatic", "automatic", "machine.status.read"),
      action("select_mode", "Select ask/auto/full through the owner-facing Gateway mode command; this read-only system surface cannot change it.", "user-mediated", "user-mediated", undefined, "gateway-mode-command", "codex-turn-execution"),
    ],
    failureDomain: "floral",
    tags: ["agent", "runtime", "authorization"],
  }),
  definition({
    id: "floral.workspace",
    displayName: "Project Workspace",
    description: "Machine-local workspace root and project-scoped execution boundary.",
    kind: "workspace",
    owner: authority("user", "Machine owner", "Chooses the workspace root and project access boundary."),
    authority: authority("floral", "ProjectWorkspaceRoot", "Resolves and enforces project paths beneath the machine-local workspace root."),
    stateSources: [
      source("machine-policy", "environment", "authoritative", ["workspace_root_configured"], "Machine-local FLORAL_WORKSPACE_ROOT presence without exposing or inferring a path."),
    ],
    managementActions: [
      action("read", "Read whether the project workspace boundary is configured.", "automatic", "automatic", "machine.status.read"),
    ],
    failureDomain: "project",
    tags: ["workspace", "security"],
  }),
  definition({
    id: "floral.storage",
    displayName: "FLORAL Durable Storage",
    description: "SQLite-backed gateway identity, audit, conversation, and project-selection state.",
    kind: "storage",
    owner: authority("floral", "FLORAL", "Owns gateway metadata persistence, not Codex-native memory content."),
    authority: authority("floral", "GatewayStore", "Owns FLORAL durable metadata records."),
    stateSources: [
      source("configuration-authority", "configuration", "supporting", ["configured"], "Effective configuration indicates a database path without exposing the path in Phase 8A evidence."),
    ],
    managementActions: [
      action("read", "Read bounded storage availability metadata.", "automatic", "automatic", "machine.status.read"),
    ],
    failureDomain: "storage",
    tags: ["storage"],
  }),
  definition({
    id: "codex.runtime",
    displayName: "Codex App Server Runtime",
    description: "Codex-owned agent runtime for threads, turns, tools, Skills, MCP, Apps, and sandbox execution.",
    kind: "runtime",
    owner: authority("codex", "Codex App Server", "Owns agent runtime semantics and native execution behavior."),
    authority: authority("codex", "Codex runtime RPC", "Live App Server RPC is the current-state authority for supported runtime facts."),
    stateSources: [
      source("configuration-authority", "configuration", "supporting", ["configured_mode", "configured_model", "configured_sandbox", "configured_approval"], "FLORAL effective configuration expresses requested runtime intent."),
      source("codex-runtime", "runtime-rpc", "observational", ["runtime_name"], "Live runtime adapter identity."),
    ],
    managementActions: [
      action("read", "Read bounded runtime metadata through supported FLORAL/Codex surfaces.", "automatic", "automatic", "machine.status.read"),
    ],
    secretDependencies: ["DEEPSEEK_API_KEY"],
    failureDomain: "codex",
    tags: ["agent", "runtime"],
  }),
  definition({
    id: "codex.skills",
    displayName: "Codex Skills",
    description: "Codex-native Skill discovery for built-in, project, and approved shared Skill roots.",
    kind: "skill",
    owner: authority("codex", "Codex", "Owns native Skill discovery and invocation semantics."),
    authority: authority("codex", "Codex skills/list", "Live Skill discovery is the runtime truth for what Codex can currently see."),
    parentId: "codex.runtime",
    stateSources: [
      source("codex-skills", "runtime-rpc", "authoritative", ["discovered"], "Codex Skill discovery for the current project scope."),
    ],
    managementActions: [
      action("read", "List currently discoverable Skills.", "automatic", "automatic", "machine.status.read"),
    ],
    failureDomain: "codex",
    tags: ["skill", "extension"],
  }),
  definition({
    id: "codex.apps",
    displayName: "Codex Apps",
    description: "Codex App directory visibility and installed/callable runtime evidence kept on separate authority lanes.",
    kind: "app",
    owner: authority("codex", "Codex/OpenAI App ecosystem", "Owns App directory, installation, authentication, grants, and callable runtime semantics."),
    authority: authority("codex", "Codex app RPC", "app/installed is installed/callable authority; app/list is directory authority only."),
    parentId: "codex.runtime",
    stateSources: [
      source("codex-app-installed", "runtime-rpc", "authoritative", ["installed", "callability"], "app/installed result when supported; directory fallback never becomes installed evidence."),
      source("codex-app-directory", "runtime-rpc", "authoritative", ["directory"], "app/list directory visibility and accessibility."),
      source("codex-app-fallback", "runtime-rpc", "observational", ["directory_fallback"], "app/list fallback used only when app/installed is unsupported; installed/callable remains unknown."),
    ],
    managementActions: [
      action("read", "Read installed runtime evidence, directory candidates, and App metadata.", "automatic", "automatic", "machine.status.read"),
      action("install", "Prepare a supported App installation handoff; user completes upstream installation/authentication.", "user-mediated", "user-mediated", undefined, "floral_extensions/prepare_app_install", "floral_extensions/verify_extension"),
      action("remove", "App removal is not exposed as a FLORAL production management action.", "unsupported", "not-applicable"),
    ],
    failureDomain: "codex",
    tags: ["app", "extension"],
  }),
  definition({
    id: "codex.mcp",
    displayName: "Codex MCP Runtime",
    description: "Codex runtime status, authentication, and advertised tool surface for configured MCP servers.",
    kind: "mcp",
    owner: authority("codex", "Codex", "Owns MCP host process integration and runtime server/tool exposure."),
    authority: authority("codex", "mcpServerStatus/list", "Live MCP status and advertised tools are runtime health truth."),
    parentId: "codex.runtime",
    stateSources: [
      source("codex-mcp-status", "runtime-rpc", "authoritative", ["servers"], "Codex MCP server status list including tools, auth state, and failure class."),
      source("floral-mcp-registry", "configuration", "supporting", ["configured_servers"], "FLORAL built-in MCP registry describes configured intent, not readiness."),
    ],
    managementActions: [
      action("read", "Read live MCP runtime status and tools.", "automatic", "automatic", "machine.status.read"),
    ],
    failureDomain: "codex",
    tags: ["mcp", "extension"],
  }),
  definition({
    id: "codex.plugins",
    displayName: "Codex Plugins",
    description: "Codex native Plugin feature-state observation; App Server Plugin write RPCs remain outside FLORAL production management.",
    kind: "plugin",
    owner: authority("codex", "Codex", "Owns Plugin feature lifecycle and upstream installation surfaces."),
    authority: authority("codex", "experimentalFeature/list", "Live native feature state is observational truth for Plugin feature availability."),
    parentId: "codex.runtime",
    stateSources: [
      source("codex-native-features", "runtime-rpc", "authoritative", ["features"], "Codex native feature-state list."),
    ],
    managementActions: [
      action("read", "Read native Plugin/App feature state.", "automatic", "automatic", "machine.status.read"),
      action("install", "Plugin installation is not exposed through FLORAL production App Server write RPCs.", "unsupported", "not-applicable"),
    ],
    failureDomain: "codex",
    tags: ["plugin", "extension"],
  }),
  definition({
    id: "extensions.external_skills",
    displayName: "External Skill Registry",
    description: "FLORAL-curated lifecycle metadata for approved third-party shared Skill packages.",
    kind: "extension",
    owner: authority("third-party", "External Skill packages", "Own source repositories and Skill content."),
    authority: authority("floral", "ExternalSkillRegistry", "Owns FLORAL installation/enabled metadata; Codex discovery remains separate runtime evidence."),
    stateSources: [
      source("external-skill-registry", "registry", "authoritative", ["packages"], "Machine-local curated External Skill registry."),
    ],
    managementActions: extensionLifecycleActions("floral_extensions/apply_extension", "floral_extensions/verify_extension"),
    failureDomain: "third-party",
    tags: ["skill", "extension", "supply-chain"],
  }),
  definition({
    id: "extensions.external_mcp",
    displayName: "External MCP Registry",
    description: "FLORAL-curated lifecycle metadata for approved third-party MCP integrations such as GitHub and Chrome DevTools.",
    kind: "extension",
    owner: authority("third-party", "External MCP providers", "Own external MCP implementations and upstream services."),
    authority: authority("floral", "ExternalMcpRegistry", "Owns FLORAL installed/enabled metadata; Codex runtime status remains separate health evidence."),
    stateSources: [
      source("external-mcp-registry", "registry", "authoritative", ["packages"], "Machine-local curated External MCP registry."),
      source("external-mcp-auth", "environment", "authoritative", ["auth_presence"], "Presence-only authentication prerequisites; credential values are never exposed."),
    ],
    managementActions: extensionLifecycleActions("floral_extensions/apply_extension", "floral_extensions/verify_extension"),
    secretDependencies: ["GITHUB_PAT_TOKEN"],
    failureDomain: "third-party",
    tags: ["mcp", "extension", "supply-chain"],
  }),
  definition({
    id: "deepseek.provider",
    displayName: "DeepSeek Provider",
    description: "Model provider behind the FLORAL/Codex bridge boundary.",
    kind: "provider",
    owner: authority("provider", "DeepSeek", "Owns model API service behavior and upstream availability."),
    authority: authority("floral", "Provider bridge", "Owns bounded provider configuration and observes request outcomes."),
    stateSources: [
      source("configuration-authority", "configuration", "authoritative", ["configured_model", "configured_endpoint", "credential_present"], "Safe provider configuration metadata and credential presence only."),
    ],
    managementActions: [
      action("read", "Read safe provider configuration and credential presence.", "automatic", "automatic", "machine.status.read"),
    ],
    secretDependencies: ["DEEPSEEK_API_KEY"],
    failureDomain: "provider",
    tags: ["provider", "model"],
  }),
  definition({
    id: "search.searxng",
    displayName: "SearXNG Search Service",
    description: "Local search backend used by FLORAL search MCP; configured intent and observed service health are distinct.",
    kind: "service",
    owner: authority("third-party", "SearXNG", "Owns search service implementation."),
    authority: authority("floral", "SearXNG adapter", "Owns deployment configuration and observes local service health."),
    stateSources: [
      source("configuration-authority", "configuration", "authoritative", ["configured_endpoint"], "Effective local search service configuration."),
    ],
    managementActions: [
      action("read", "Read safe configuration and health evidence when available.", "automatic", "automatic", "machine.status.read"),
    ],
    failureDomain: "mixed",
    tags: ["search", "service"],
  }),
  definition({
    id: "mcp.floral_search",
    displayName: "FLORAL Search MCP",
    description: "FLORAL-controlled MCP exposure for SearXNG web search.",
    kind: "mcp",
    owner: authority("floral", "FLORAL", "Owns MCP gateway policy and configured tool exposure."),
    authority: authority("codex", "Codex MCP runtime", "Live advertised tool status determines runtime readiness."),
    parentId: "codex.mcp",
    stateSources: [
      source("floral-mcp-registry", "configuration", "authoritative", ["configured"], "FLORAL built-in MCP registry intent."),
      source("codex-mcp-status", "runtime-rpc", "authoritative", ["runtime"], "Codex runtime status for floral_search."),
    ],
    managementActions: [action("read", "Read configured and runtime status.", "automatic", "automatic", "machine.status.read")],
    failureDomain: "mixed",
    tags: ["mcp", "search"],
  }),
  definition({
    id: "mcp.floral_vision",
    displayName: "FLORAL Vision MCP",
    description: "FLORAL-controlled visual analysis MCP backed by MiMo with bounded trusted input roots.",
    kind: "mcp",
    owner: authority("floral", "FLORAL", "Owns visual MCP gateway, input policy, and tool exposure."),
    authority: authority("codex", "Codex MCP runtime", "Live advertised tool status determines runtime readiness."),
    parentId: "codex.mcp",
    stateSources: [
      source("floral-mcp-registry", "configuration", "authoritative", ["configured"], "FLORAL built-in MCP registry intent."),
      source("codex-mcp-status", "runtime-rpc", "authoritative", ["runtime"], "Codex runtime status for floral_vision."),
    ],
    managementActions: [action("read", "Read configured and runtime status.", "automatic", "automatic", "machine.status.read")],
    secretDependencies: ["MIMO_API_KEY"],
    failureDomain: "mixed",
    tags: ["mcp", "vision"],
  }),
  definition({
    id: "mcp.floral_peekaboo",
    displayName: "FLORAL Peekaboo MCP",
    description: "FLORAL-controlled macOS observation and approval-gated element-click gateway over Peekaboo.",
    kind: "mcp",
    owner: authority("floral", "FLORAL gateway", "Owns tool allowlisting, artifact boundary, and approval mapping."),
    authority: authority("codex", "Codex MCP runtime", "Live advertised tool status determines runtime readiness; Peekaboo owns GUI execution results."),
    parentId: "codex.mcp",
    stateSources: [
      source("floral-mcp-registry", "configuration", "authoritative", ["configured"], "FLORAL built-in MCP registry intent including image/see/click exposure."),
      source("codex-mcp-status", "runtime-rpc", "authoritative", ["runtime"], "Codex runtime status for floral_peekaboo."),
    ],
    managementActions: [action("read", "Read configured and runtime status.", "automatic", "automatic", "machine.status.read")],
    failureDomain: "host",
    tags: ["mcp", "macos", "vision"],
  }),
  definition({
    id: "transport.feishu",
    displayName: "Feishu Transport",
    description: "Primary FLORAL chat transport with text and bounded inbound/outbound media handling.",
    kind: "transport",
    owner: authority("third-party", "Feishu", "Owns messaging platform delivery and platform identity."),
    authority: authority("floral", "Feishu transport adapter", "Owns FLORAL connection and message adaptation while upstream API results remain delivery truth."),
    stateSources: [
      source("configuration-authority", "configuration", "supporting", ["configured_mode", "credential_presence"], "Transport configuration and credential presence only."),
    ],
    managementActions: [action("read", "Read safe transport configuration metadata.", "automatic", "automatic", "machine.status.read")],
    secretDependencies: ["FEISHU_APP_ID", "FEISHU_APP_SECRET"],
    failureDomain: "transport",
    tags: ["transport", "feishu"],
  }),
  definition({
    id: "transport.qq",
    displayName: "QQ Compatibility Transport",
    description: "Compatibility chat transport through the QQ Bot SDK.",
    kind: "transport",
    owner: authority("third-party", "QQ", "Owns messaging platform delivery and platform identity."),
    authority: authority("floral", "QQ transport adapter", "Owns FLORAL SDK adaptation while upstream API results remain delivery truth."),
    stateSources: [
      source("configuration-authority", "configuration", "supporting", ["configured_mode", "credential_presence"], "Transport configuration and credential presence only."),
    ],
    managementActions: [action("read", "Read safe transport configuration metadata.", "automatic", "automatic", "machine.status.read")],
    secretDependencies: ["QQBOT_APP_ID", "QQBOT_APP_SECRET"],
    failureDomain: "transport",
    tags: ["transport", "qq"],
  }),
] as const;

interface DefinitionInput extends Omit<SystemDefinition, "schemaVersion" | "stateSources" | "managementActions" | "secretDependencies" | "tags"> {
  stateSources?: readonly SystemStateSourceDefinition[] | undefined;
  managementActions?: readonly ManagementActionDefinition[] | undefined;
  secretDependencies?: readonly string[] | undefined;
  tags?: readonly string[] | undefined;
}

function definition(input: DefinitionInput): SystemDefinition {
  return {
    schemaVersion: SYSTEM_AWARENESS_SCHEMA_VERSION,
    ...input,
    stateSources: input.stateSources ?? [],
    managementActions: input.managementActions ?? [],
    secretDependencies: input.secretDependencies ?? [],
    tags: input.tags ?? [],
  };
}

function authority(
  party: SystemAuthorityParty,
  name: string,
  responsibility: string,
): SystemDefinition["owner"] {
  return { party, name, responsibility };
}

function source(
  id: string,
  kind: SystemEvidenceSourceKind,
  sourceAuthority: SystemStateSourceDefinition["authority"],
  facts: readonly string[],
  description: string,
  availability?: SystemStateSourceDefinition["availability"],
): SystemStateSourceDefinition {
  return {
    id,
    kind,
    authority: sourceAuthority,
    facts,
    description,
    ...(availability ? { availability } : {}),
  };
}

function action(
  id: string,
  description: string,
  disposition: ManagementActionDefinition["disposition"],
  approval: ManagementActionDefinition["approval"],
  capability?: ManagementActionDefinition["capability"],
  executor?: string,
  verification?: string,
): ManagementActionDefinition {
  return {
    id,
    description,
    disposition,
    approval,
    ...(capability ? { capability } : {}),
    ...(executor ? { executor } : {}),
    ...(verification ? { verification } : {}),
  };
}

function extensionLifecycleActions(
  executor: string,
  verification: string,
): readonly ManagementActionDefinition[] {
  return [
    action("read", "Read curated installation/enabled metadata.", "automatic", "automatic", "machine.status.read"),
    action("install", "Install an approved curated extension.", "approval-gated", "chat-confirmation", "software.install", executor, verification),
    action("update", "Update an approved curated extension.", "approval-gated", "chat-confirmation", "software.install", executor, verification),
    action("enable", "Enable an installed curated extension.", "approval-gated", "chat-confirmation", "software.install", executor, verification),
    action("disable", "Disable an installed curated extension.", "approval-gated", "chat-confirmation", "software.install", executor, verification),
    action("remove", "Remove an installed curated extension.", "approval-gated", "chat-confirmation", "software.install", executor, verification),
  ];
}
