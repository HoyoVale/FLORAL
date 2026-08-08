# Architecture

```text
QQ SDK → ChatTransport → GatewayService → AgentRuntime → Codex app-server
                               │                │
                               │                └─ Skills / MCP / Sandbox / Threads
                               ├─ Identity / Role / Approval / Audit
                               └─ Conversation ↔ Codex thread mapping

Codex app-server → local MCP stdio → Peekaboo → macOS GUI
Codex app-server → configured Responses-compatible model provider
Future optional ModelBridge → provider-specific wire protocol
```

The gateway owns business identity and policy. Codex owns agent execution. Peekaboo owns GUI automation. This separation allows QQ, Codex, the model provider, or Peekaboo to be replaced independently.

`src/agent/model-bridge.ts` reserves a protocol-conversion boundary only. Phase 1 does not enable a bridge or claim that a Chat Completions-compatible provider can be used directly by the current Codex App Server.

The default implementation uses an in-memory thread store only to make the bootstrap executable. A later persistence phase replaces it with SQLite and records one active Codex thread per product conversation.

## Phase 7.2A: Codex-native project/chat control plane

When `FLORAL_WORKSPACE_ROOT` is configured on the Mac, FLORAL treats its real direct-child directories as projects. The selected project path becomes the Codex turn `cwd`; no FLORAL project object duplicates the directory itself.

```text
Workspace Root (Mac-local trust boundary)
├── FLORAL/       -> Codex cwd
│   ├── thread A
│   └── thread B
├── WISTERIA/     -> Codex cwd
│   ├── thread C
│   └── thread D
└── ...
```

Codex remains the authority for thread storage and history. `/chats` calls app-server `thread/list` with the selected project cwd and renders a temporary numbered view. SQLite stores only the selected project name and the active Codex thread ID for each `(conversation, project)` pair. Switching projects therefore changes both cwd and the thread-state bucket; a thread is never intentionally resumed across projects.

`/projects`, `/project <name>`, `/chats`, `/chat <n>`, and `/chat new` form the first control-plane surface. Project creation/import and thread archival are intentionally deferred to the next subphase.

## Phase 7.2B project/chat lifecycle control

FLORAL may create a new project only as a real direct child of the already configured Workspace Root via `/project new <name>`. The command is owner-only and does not expand the Workspace Root trust boundary. FLORAL still maps each project to its directory `cwd` and leaves conversation history in Codex native threads. `/chat archive <index>` resolves an opaque thread ID only from a fresh `/chats` cache and delegates the mutation to Codex `thread/archive`; raw thread IDs are never accepted from chat.

## Phase 7.3A project-shared context bootstrap

FLORAL uses Codex-native `AGENTS.md` discovery as the project instruction entry point rather than injecting a parallel hidden memory prompt. Project-shared durable context lives in ordinary project files:

```text
Project/
├── AGENTS.md (or an existing AGENTS.override.md)
└── .floral/
    ├── CONTEXT.md
    ├── DECISIONS.md
    └── KNOWN_ISSUES.md
```

`/project new <name>` bootstraps this structure before the first Codex thread is created. Existing projects can opt in with `/project context init`; the command never replaces existing context files. If an `AGENTS.override.md` already exists, FLORAL links the shared-context guidance there because Codex gives it precedence over `AGENTS.md`. Otherwise it appends a bounded managed block to the existing `AGENTS.md`, or creates a minimal `AGENTS.md` if none exists.

The `.floral/*.md` files are not automatically injected or summarized by FLORAL. The managed AGENTS block tells Codex where the shared project documents live; Codex then follows its normal project-instruction behavior. Phase 7.3A is bootstrap/read-mostly infrastructure only: automatic extraction, consolidation, and memory writing are deferred to Phase 7.3B.

## Phase 7.3B explicit durable project memory

Phase 7.3B keeps Codex thread history and project-shared durable memory separate. FLORAL does not summarize ordinary chats automatically. A bound owner explicitly records categorized items with `/project remember context|decision|issue <text>`; the host writes only to the current project's initialized `.floral` context files.

Writes are bounded, deduplicated, audited by fingerprint rather than raw text, and rejected while an Agent run is active. Existing project files remain the source of truth; this phase does not introduce a second database or Codex-internal memory dependency.


## Phase 7.4A Codex-native memory adoption

FLORAL now enables the Codex native memories subsystem through the same generated `CODEX_HOME/config.toml` authority used for the rest of the Codex runtime. The unified config emits `features.memories=true` plus `memories.use_memories=true`, `memories.generate_memories=true`, and `memories.disable_on_external_context=false`.

The native memory store belongs to Codex under the managed `CODEX_HOME`; FLORAL does not parse or mutate Codex memory artifacts as an application database. `CODEX_HOME/memories` is inspected only for diagnostics. The controlled unified-config cutover remains the compatibility gate: if the installed Codex rejects the memory config, startup falls back to the established legacy config and status/probe output reports native memory as configured but not active.

Codex native memories are cross-thread recall state, while project `AGENTS.md` and repository/project documents remain deterministic project guidance. If recalled memory conflicts with the checked-in project source of truth, the project source wins. Phase 7.3 explicit `.floral` project notes remain temporarily available as a compatibility layer but are not extended into an automatic FLORAL memory engine.


## Phase 7.4B native memory lifecycle acceptance

Phase 7.4B keeps Codex as the only automatic-memory engine and adds an observation-only acceptance layer around its generated state. FLORAL classifies bounded filesystem metadata under the managed `CODEX_HOME/memories` directory as `armed`, `generated`, or `consolidated`; it does not parse memory contents, mutate Codex memory files, or query Codex internal SQLite tables.

`/memory` exposes the same lifecycle state remotely without starting a model turn. `codex:native-memory:lifecycle` provides the terminal equivalent, while `codex:native-memory:lifecycle:check` requires a consolidated `MEMORY.md` artifact and is intentionally stricter than configuration activation. Consolidated artifacts are evidence that the generation pipeline ran, not proof that a new thread actually received or used a memory; cross-thread recall remains a separate behavioral acceptance test.

The CLI feature probe now resolves the configured Codex executable through PATH first and then the official standalone locations under the user home directory. An unavailable auxiliary feature probe is diagnostic-only; an explicitly disabled `memories` feature or a non-unified active config remains a failure.
