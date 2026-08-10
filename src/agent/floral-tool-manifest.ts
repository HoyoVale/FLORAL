import { FLORAL_CONTEXT_DYNAMIC_TOOLS } from "./floral-context-tools.js";

export const FLORAL_AGENT_DEVELOPER_INSTRUCTIONS = [
  "FLORAL capability routing policy:",
  "- For deterministic macOS application operations, prefer terminal/native CLI or a documented installed application CLI when it directly expresses the requested semantic action. Examples include macOS open/open -a for launching or opening a target, application CLIs for opening workspaces/files, and read-only process/status commands. These commands remain subject to the active Codex sandbox and FLORAL approval policy.",
  "- Terminal-first does not authorize synthetic GUI automation. Never use direct Peekaboo CLI mutation, osascript/AppleScript/System Events, cliclick, coordinate automation, or ad-hoc accessibility scripts to synthesize clicks or keystrokes.",
  "- For macOS screen observation, use floral_peekaboo/image or floral_peekaboo/see. Use floral_vision only for pixel semantics or OCR. After a terminal/native action that should change visible state, verify with see when the command result alone is insufficient.",
  "- When a step has no reliable terminal/native CLI route and requires GUI interaction, floral_peekaboo/see is mandatory immediately before the action. Select the target only from the fresh Snapshot ID and opaque element ID returned by see. Do not infer an actionable target from visual coordinates, arrow direction, OCR, or a screenshot.",
  "- For GUI mutation, use only FLORAL-exposed controlled GUI tools such as floral_peekaboo/click when it is currently available. Availability is runtime state: consult floral_system when it matters; if the required governed route is unavailable, state the limitation instead of bypassing FLORAL.",
  "- If the requested UI is already in the desired state, do not mutate it and do not request approval.",
  "- After every successful click, call floral_peekaboo/see again before evaluating state or doing another GUI action.",
  "- A local filesystem path or Markdown link/image is not a delivered chat attachment.",
  "- When the user explicitly asks to receive a screenshot or another already-registered artifact, call floral_delivery/send_artifact with the artifactId returned by the trusted producer. Never claim delivery unless that tool reports success.",
  "- For terminal-produced files, first create or copy the final attachment into <cwd>/artifacts/outbound, then call floral_delivery/register_outbound_file, then floral_delivery/send_artifact. Do not register or send arbitrary paths outside that staging root.",
  "- Manage Skills through floral_skills and Codex-native Skill discovery. For a new or updated Project Skill, use the skill-creator workflow to write a draft under <cwd>/.agents/skill-drafts/<name>, including SKILL.md and proposal.json; call draft_status, then publish_draft with the returned exact digest. FLORAL atomically publishes only after scoped approval and verifies through Codex-native Skill discovery/config. Never write <cwd>/.agents/skills directly, edit runtime registries, or use shell/git to bypass Skill governance.",
  "- Discover and manage supported extensions through floral_extensions. Use floral_system when current ownership, readiness, or management authority matters. For a capability gap or extension lifecycle request, call floral_extensions/plan_extension first; treat its current_state/status/recommended_action as the deterministic control-plane plan for this frozen turn.",
  "- Only call floral_extensions/apply_extension when plan_extension returns action-required and the requested exact action matches recommended_action. External MCP/Skill mutation is policy-gated by an exact extension.<action> capability and structured target/source/integrity scope. In paired-owner full mode the host may auto-approve a chat-confirmation only after AuthorizationAuthority accepts that exact curated action; this does not widen the catalog or let the model bypass plan/apply/verify. If the plan says no-op, prerequisite-required, diagnose-first, unknown, or unsupported, do not mutate merely to try. App install/auth/remove remain upstream/user-owned: review through app_permission_review and use prepare_app_install only for user-handoff. Installed App enable/disable may use the exact planned apply_extension action, which is executed only through Codex native config RPC and requires fresh-turn verification.",
  "- Plugin App Server list/read/install/uninstall RPCs are upstream under development and forbidden to production clients. Use floral_extensions/prepare_plugin_management for the supported Codex CLI /plugins or ChatGPT Plugin Directory handoff, then require a new session and capability verification.",
  "- Extension control-plane routing overrides terminal-first application routing. After any controlled extension mutation or App install handoff, the current turn's extension/System Awareness snapshot predates the change and cannot verify adoption. End the current turn with verification pending. On a fresh next turn use floral_extensions/verify_extension; use mcp_status or system diagnostics only as supporting read-only views. Do not inspect ~/.codex, process tables, package storage, data/external-* registries, or run shell/git/npm/pnpm/codex extension commands to compensate.",
  "- Legacy manage_mcp/manage_external are not exposed to Agent turns. Extension operations not exposed by FLORAL are unsupported for this Agent turn. Never use shell, direct Codex config edits, undocumented RPCs, arbitrary package sources, or package managers as an extension-install workaround; consult floral_system/capabilities for the current management contract.",
  "- Manage shared project memory through floral_context only. Read current context before relying on it; create a turn-bound proposal before applying an update. Applying an update is host approval-gated and writes only the selected managed .floral document with a provenance receipt. Never edit AGENTS.md, .floral files, or the provenance ledger through shell or direct file tools. Use compact to reconcile provenance freshness without rewriting document bodies.",
  "- Manage durable task objectives through floral_goal, which delegates to Codex app-server thread/goal RPCs. Read status whenever useful, but create, replace, pause, resume, complete, block, change a budget, or clear a Goal only when the user explicitly requests that durable Goal action. Never infer a Goal from an ordinary task. Set a token budget only when the user explicitly supplies one.",
].join("\n");

export const FLORAL_SYSTEM_DEVELOPER_INSTRUCTIONS = [
  "FLORAL runtime self-awareness, diagnostics, and governed maintenance policy:",
  "- floral_system is the primary control-plane interface for questions about FLORAL itself. Developer instructions are routing and safety invariants, not evidence of current state. When a claim depends on current FLORAL availability, ownership, health, permissions, or management authority, query floral_system instead of relying on memorized architecture prose.",
  "- If floral_system is unavailable on a resumed legacy thread, state that the thread lacks the current System Awareness tool surface and ask the owner to start /new. Do not fall back to shell, filesystem enumeration, process inspection, or network probing as an imitation of the missing control plane.",
  "- For a broad FLORAL health/diagnosis request, call floral_system/diagnose first. If it reports healthy and the user did not explicitly request independent host-level investigation, answer from that evidence-backed result. Do not opportunistically run shell commands, list dot-directories, inspect process tables, read ad-hoc context files, or probe the network merely to add more certainty.",
  "- If the user asks only to diagnose, inspect, explain, or says not to modify/repair anything, do not call floral_system/maintain and do not request mutation approvals. Read-only checks listed by diagnose are recommendations, not automatic tool calls. Only perform a listed supplemental check when the user asked for deeper investigation and the named governed/read-only interface is actually available.",
  "- Never treat .floral/CONTEXT.md, .floral/DECISIONS.md, .floral/KNOWN_ISSUES.md, arbitrary repository files, shell output, or generic model environment prose as a substitute for System Awareness authority unless the user explicitly asks for an independent project/host investigation outside the System Map.",
  "- Codex Native Memory is recall assistance only. Current System Awareness evidence, repository truth, owner-confirmed decisions, and verified FLORAL Context receipts outrank recalled memory. Never use recalled memory to override fresher evidence.",
  "- Do not propose ephemeral runtime values such as PID, current readiness, current cost/token counters, or transient MCP/process state to floral_context. Those belong to System Awareness and diagnostics, not durable project memory.",
  "- Use floral_system/current_context before claiming the current FLORAL control mode, requested sandbox, effective Codex permission selector, approval policy, or reviewer. turn.* facts under floral.execution are the FLORAL authority for what this host actually sent to Codex for the current turn.",
  "- Configured defaults are intent, not the effective turn selector. Generic Codex/model environment or sandbox prose is not a FLORAL evidence source and must not be presented as a competing FLORAL authority. If such context disagrees with floral.execution, report the FLORAL evidence and do not invent a reconciliation.",
  "- system_summary, component_status, current_context, capabilities, and diagnose are read-only views or deterministic derivations of a snapshot captured before the current turn. Treat unknown and conflict as valid states; never use shell, config files, or guesswork to upgrade them into certainty.",
  "- Use floral_system/diagnose when the user asks why a FLORAL component is unavailable, degraded, conflicting, or not exposing an expected capability. Diagnostic findings are derived hypotheses over evidence, not new authoritative facts; preserve their confidence, failure-domain ordering, limitations, and read-only check sequence.",
  "- Governed self-maintenance is exposed only through floral_system/maintain for actions explicitly declared by floral_system/capabilities. Never use shell, launchctl, direct config edits, or generic command execution as a maintenance bypass. Before proposing maintain, inspect diagnose and capabilities; the host independently enforces the declared action, capability, approval requirement, bounded executor, and verification contract.",
  "- Paired-owner full mode is a host trust policy, not model authority: chat-confirmation operations already accepted by AuthorizationAuthority may be auto-approved, but Mac-local capabilities and unsupported/unallowlisted routes remain blocked. Do not manufacture approval by describing an operation as trusted.",
  "- floral_system/maintain is a mutation. It must not be called during diagnosis-only requests. Restart approval is governed by floral.maintenance autonomy_policy: manual requires Mac-local confirmation; owner-auto may bypass per-action local confirmation only for a direct owner restart request recognized by the host; self-heal is triggered only by the host supervisor from deterministic high-confidence repair rules. The model cannot self-label a request as owner-auto or self-heal. User-triggered restarts are queued for post-reply handoff; the initiating turn cannot claim success. Verification comes from the maintenance receipt in a fresh turn after the service returns.",
  "- The per-turn snapshot is frozen. A mutation performed later in the same turn does not refresh floral_system; use a fresh next turn or an owner-facing status command for post-mutation verification.",
  "- floral_system/capabilities describes declared ownership, management disposition, approval requirements, and verification contracts only. It grants no authorization. A maintenance tool call is separately governed and never inherits authorization from diagnostic metadata.",
].join("\n");

const FLORAL_DELIVERY_DYNAMIC_TOOLS = [
  {
    type: "namespace",
    name: "floral_delivery",
    description: "FLORAL-controlled delivery of trusted local artifacts to the current chat. Registration is not delivery; outbound DLP is enforced by the host.",
    tools: [
      {
        type: "function",
        name: "register_outbound_file",
        description: "Register one regular file already staged under <cwd>/artifacts/outbound. Returns an artifactId. This does not send the file.",
        inputSchema: {
          type: "object",
          properties: {
            local_path: {
              type: "string",
              minLength: 1,
              maxLength: 4096,
              description: "Absolute path to a file under <cwd>/artifacts/outbound.",
            },
            file_name: {
              type: "string",
              minLength: 1,
              maxLength: 180,
              description: "Optional attachment file name without path separators.",
            },
            caption: {
              type: "string",
              minLength: 1,
              maxLength: 240,
              description: "Optional short caption to keep with the artifact.",
            },
          },
          required: ["local_path"],
          additionalProperties: false,
        },
        deferLoading: false,
      },
      {
        type: "function",
        name: "send_artifact",
        description: "Send one previously registered trusted artifact to the current chat. Accepts artifactId only, never an arbitrary filesystem path. Success means the transport reported the media/file message was sent.",
        inputSchema: {
          type: "object",
          properties: {
            artifact_id: {
              type: "string",
              pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$",
              description: "Artifact ID returned by a trusted producer or register_outbound_file.",
            },
            caption: {
              type: "string",
              minLength: 1,
              maxLength: 240,
              description: "Optional caption override for this delivery.",
            },
          },
          required: ["artifact_id"],
          additionalProperties: false,
        },
        deferLoading: false,
      },
    ],
  },
] as const;

const FLORAL_SKILLS_DYNAMIC_TOOLS = [
  {
    type: "namespace",
    name: "floral_skills",
    description: "FLORAL-controlled Skill discovery and management. Builtin Skills are immutable; shared external supply-chain mutations require user approval.",
    tools: [
      {
        type: "function",
        name: "list",
        description: "List Skills currently discovered for this Project/runtime with FLORAL source classification.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        deferLoading: false,
      },
      {
        type: "function",
        name: "refresh",
        description: "Force Codex to reload the current Project/runtime Skill catalog from disk.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        deferLoading: false,
      },
      {
        type: "function",
        name: "set_enabled",
        description: "Enable or disable one discovered non-builtin Skill in the current Codex runtime using native skills/config/write.",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              minLength: 1,
              maxLength: 128,
            },
            enabled: { type: "boolean" },
          },
          required: ["name", "enabled"],
          additionalProperties: false,
        },
        deferLoading: false,
      },
      {
        type: "function",
        name: "external_catalog",
        description: "Read the curated shared External Skill package catalog and installation state.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        deferLoading: false,
      },
      {
        type: "function",
        name: "draft_status",
        description: "Validate one Project Skill draft under <cwd>/.agents/skill-drafts/<name>. Checks Codex Skill schema, bounded file structure, declared permissions, trigger/negative tests, policy bypass patterns, collisions, and returns an exact digest. This is read-only.",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
              maxLength: 64,
            },
          },
          required: ["name"],
          additionalProperties: false,
        },
        deferLoading: false,
      },
      {
        type: "function",
        name: "publish_draft",
        description: "Publish one already validated Project Skill draft. Requires the exact digest from draft_status, revalidates after approval, atomically installs under <cwd>/.agents/skills, enables through native skills/config/write, verifies native discovery, and rolls back on failure.",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
              maxLength: 64,
            },
            digest: {
              type: "string",
              pattern: "^sha256:[0-9a-f]{64}$",
            },
          },
          required: ["name", "digest"],
          additionalProperties: false,
        },
        deferLoading: false,
      },
      {
        type: "function",
        name: "publication_history",
        description: "Read bounded project-specific Project Skill publication and rollback receipts from FLORAL runtime data.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        deferLoading: false,
      },
    ],
  },
] as const;

const FLORAL_EXTENSIONS_DYNAMIC_TOOLS = [
  {
    type: "namespace",
    name: "floral_extensions",
    description: "Controlled extension surface: deterministic planning; governed curated External MCP/Skill mutation; native Codex App enable/disable plus user-mediated install/auth handoff; supported Plugin management handoff; and fresh-turn verification.",
    tools: [
      {
        type: "function",
        name: "native_status",
        description: "Report Codex native apps/plugins feature lifecycle state and FLORAL Plugin API maturity policy.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        deferLoading: false,
      },
      {
        type: "function",
        name: "installed_apps",
        description: "Read the per-turn snapshot of installed Codex connector Apps for the current runtime/thread, including effective enabled and callable state.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        deferLoading: false,
      },
      {
        type: "function",
        name: "available_apps",
        description: "Read the per-turn Codex App directory snapshot, including accessibility, local enabled state, and a supported-surface install URL when Codex provides one.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        deferLoading: false,
      },
      {
        type: "function",
        name: "prepare_app_install",
        description: "Prepare a safe supported-surface installation handoff for one App directory entry. This does not install, authenticate, or grant connector access by itself.",
        inputSchema: {
          type: "object",
          properties: {
            app_id: {
              type: "string",
              minLength: 1,
              maxLength: 160,
            },
          },
          required: ["app_id"],
          additionalProperties: false,
        },
        deferLoading: false,
      },
      {
        type: "function",
        name: "app_permission_review",
        description: "Summarize one App's frozen installed/directory state, bundled plugin names, and read-only versus action tool counts before install, enable, authentication, or use. Upstream OAuth scopes remain explicitly user-reviewed when App Server does not expose them.",
        inputSchema: {
          type: "object",
          properties: {
            app_id: { type: "string", minLength: 1, maxLength: 160 },
          },
          required: ["app_id"],
          additionalProperties: false,
        },
        deferLoading: false,
      },
      {
        type: "function",
        name: "prepare_plugin_management",
        description: "Prepare a supported user handoff for browsing, installing, uninstalling, enabling, or disabling a Plugin. FLORAL does not call upstream under-development Plugin App Server RPCs from production.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["browse", "install", "uninstall", "enable", "disable"] },
            plugin_name: { type: "string", minLength: 1, maxLength: 160 },
          },
          required: ["action"],
          additionalProperties: false,
        },
        deferLoading: false,
      },
      {
        type: "function",
        name: "read_apps",
        description: "Read per-turn cached metadata and display-only tool summaries for installed Codex App ids. This does not authorize or invoke App tools.",
        inputSchema: {
          type: "object",
          properties: {
            app_ids: {
              type: "array",
              minItems: 1,
              maxItems: 20,
              items: {
                type: "string",
                minLength: 1,
                maxLength: 160,
              },
            },
            include_tools: { type: "boolean" },
          },
          required: ["app_ids"],
          additionalProperties: false,
        },
        deferLoading: false,
      },
      {
        type: "function",
        name: "plan_extension",
        description: "Build a deterministic, read-only activation/lifecycle plan for one curated MCP, curated External Skill package, or currently visible Codex App. This does not grant authorization or execute a mutation.",
        inputSchema: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["mcp", "skill", "app"] },
            id: { type: "string", minLength: 1, maxLength: 160 },
            intent: { type: "string", enum: ["activate", "update", "disable", "remove"] },
          },
          required: ["kind", "id"],
          additionalProperties: false,
        },
        deferLoading: false,
      },
      {
        type: "function",
        name: "apply_extension",
        description: "Apply one exact planned lifecycle action to a FLORAL-curated External MCP/Skill, or enable/disable an installed Codex App through native config RPC after authorization. App install/auth/remove remain user-mediated.",
        inputSchema: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["mcp", "skill", "app"] },
            action: { type: "string", enum: ["install", "update", "enable", "disable", "remove"] },
            id: { type: "string", minLength: 1, maxLength: 160 },
          },
          required: ["kind", "action", "id"],
          additionalProperties: false,
        },
        deferLoading: false,
      },
      {
        type: "function",
        name: "verify_extension",
        description: "Verify one controlled extension transaction (latest by default, or an exact transaction_id) against this turn's frozen System Awareness evidence. Use only on a fresh turn after mutation or App handoff; no shell or direct config inspection is performed.",
        inputSchema: {
          type: "object",
          properties: {
            transaction_id: {
              type: "string",
              pattern: "^[A-Z0-9]{8,24}$",
            },
          },
          additionalProperties: false,
        },
        deferLoading: false,
      },
      {
        type: "function",
        name: "extension_history",
        description: "Read recent bounded controlled-extension transaction receipts from the frozen System Awareness snapshot.",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 50 },
          },
          additionalProperties: false,
        },
        deferLoading: false,
      },
      {
        type: "function",
        name: "mcp_catalog",
        description: "List FLORAL-curated external MCP capabilities and their install/auth state. No secret values are returned.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        deferLoading: false,
      },
      {
        type: "function",
        name: "mcp_status",
        description: "Read the per-turn snapshot of Codex MCP server startup/auth/tool status.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        deferLoading: false,
      },
    ],
  },
] as const;

export const FLORAL_SYSTEM_DYNAMIC_TOOLS = [
  {
    type: "namespace",
    name: "floral_system",
    description: "FLORAL system control plane: authoritative read-only awareness/diagnostics plus narrowly governed maintenance. Diagnose before maintenance. Never substitute shell or ad-hoc filesystem probing for System Awareness. Maintenance is limited to declared actions and requires independent host authorization.",
    tools: [
      {
        type: "function",
        name: "current_context",
        description: "Read the current FLORAL Gateway execution request and the exact Codex turn permission selector captured before this turn. Use this before making claims about current mode, sandbox/profile, approval policy, or reviewer.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        deferLoading: false,
      },
      {
        type: "function",
        name: "system_summary",
        description: "Summarize FLORAL components, observer health, and resolved/unknown/conflicting fact counts from the snapshot captured before this turn.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        deferLoading: false,
      },
      {
        type: "function",
        name: "component_status",
        description: "Read one system component's owner, authority, failure domain, declared state facts, resolved values, and evidence sources. Unknown and conflict remain explicit.",
        inputSchema: {
          type: "object",
          properties: {
            component_id: {
              type: "string",
              pattern: "^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$",
              maxLength: 96,
            },
          },
          required: ["component_id"],
          additionalProperties: false,
        },
        deferLoading: false,
      },
      {
        type: "function",
        name: "diagnose",
        description: "PRIMARY/FIRST tool for broad FLORAL health or diagnosis requests. Derive bounded evidence-backed findings, likely failure domains, limitations, and an ordered read-only check plan for the whole system or one component. If this reports healthy, do not supplement it with shell/filesystem/process/network probing unless the user explicitly requested independent host-level investigation. This never executes maintenance or grants authorization.",
        inputSchema: {
          type: "object",
          properties: {
            component_id: {
              type: "string",
              pattern: "^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$",
              maxLength: 96,
            },
          },
          additionalProperties: false,
        },
        deferLoading: false,
      },
      {
        type: "function",
        name: "maintain",
        description: "Request one declared governed maintenance action. MUTATING: never call for diagnosis-only or no-change requests. floral.service/restart is governed by the host maintenance autonomy policy: manual requires Mac-local confirmation; owner-auto may auto-approve only a direct owner restart request recognized by the host; self-heal is host-supervisor-only and cannot be claimed by the model. User-triggered execution is queued until after the Agent reply and verified by persisted receipt. Never use shell/launchctl as a substitute.",
        inputSchema: {
          type: "object",
          properties: {
            component_id: {
              type: "string",
              enum: ["floral.service"],
            },
            action_id: {
              type: "string",
              enum: ["restart"],
            },
            rationale: {
              type: "string",
              minLength: 1,
              maxLength: 320,
              description: "Concise evidence-backed reason for requesting this maintenance action.",
            },
          },
          required: ["component_id", "action_id", "rationale"],
          additionalProperties: false,
        },
        deferLoading: false,
      },
      {
        type: "function",
        name: "capabilities",
        description: "Read declared management actions and their disposition, approval, capability, executor, and verification contracts. This is metadata only: no permission is granted and no action is executed.",
        inputSchema: {
          type: "object",
          properties: {
            component_id: {
              type: "string",
              pattern: "^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$",
              maxLength: 96,
            },
          },
          additionalProperties: false,
        },
        deferLoading: false,
      },
    ],
  },
] as const;

export const FLORAL_DYNAMIC_TOOLS = [
  ...FLORAL_DELIVERY_DYNAMIC_TOOLS,
  ...FLORAL_SKILLS_DYNAMIC_TOOLS,
  ...FLORAL_EXTENSIONS_DYNAMIC_TOOLS,
  ...FLORAL_CONTEXT_DYNAMIC_TOOLS,
  {
    type: "namespace",
    name: "floral_goal",
    description: "Codex-native durable Goal state for the current thread. Goal mutation requires an explicit user request.",
    tools: [
      {
        type: "function",
        name: "status",
        description: "Read the current thread Goal and its native budget/usage state.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        deferLoading: false,
      },
      {
        type: "function",
        name: "create",
        description: "Create or replace the current thread Goal only when the user explicitly requested a durable Goal.",
        inputSchema: {
          type: "object",
          properties: {
            objective: { type: "string", minLength: 1, maxLength: 4000 },
            token_budget: { type: "integer", minimum: 1 },
          },
          required: ["objective"],
          additionalProperties: false,
        },
        deferLoading: false,
      },
      {
        type: "function",
        name: "update",
        description: "Update an existing Goal status or token budget only when explicitly requested or when its objective is genuinely complete/blocked.",
        inputSchema: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["active", "paused", "blocked", "complete"] },
            token_budget: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] },
          },
          additionalProperties: false,
          minProperties: 1,
        },
        deferLoading: false,
      },
      {
        type: "function",
        name: "clear",
        description: "Clear the current thread Goal only when the user explicitly requests removal.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        deferLoading: false,
      },
    ],
  },
] as const;
