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
