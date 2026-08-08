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
