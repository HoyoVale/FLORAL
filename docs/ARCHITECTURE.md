# Architecture

```text
QQ SDK → ChatTransport → GatewayService → AgentRuntime → Codex app-server
                               │                │
                               │                └─ Skills / MCP / Sandbox / Threads
                               ├─ Identity / Role / Approval / Audit
                               └─ Conversation ↔ Codex thread mapping

Codex app-server → local MCP stdio → Peekaboo → macOS GUI
Codex app-server → Responses API → DeepSeek
```

The gateway owns business identity and policy. Codex owns agent execution. Peekaboo owns GUI automation. This separation allows QQ, Codex, DeepSeek, or Peekaboo to be replaced independently.

The default implementation uses an in-memory thread store only to make the bootstrap executable. Phase 1 replaces it with SQLite and records one active Codex thread per product conversation.
