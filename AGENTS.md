# Project instructions

This repository is a thin gateway, not a replacement agent framework.

- QQ owns message delivery and platform identity.
- Better Auth owns optional web sessions and account records.
- The policy layer owns authorization and approval decisions.
- Codex app-server owns agent threads, turns, tools, skills, MCP, and sandbox execution.
- DeepSeek integration is planned behind the provider/bridge boundary; do not assume direct wire compatibility.
- Peekaboo owns macOS GUI automation through local MCP.
- Never expose Codex app-server or Peekaboo directly to the public network.
- Never treat the language model as an authorization boundary.
- Keep mock adapters working on Windows.
- macOS-specific imports must stay inside the macOS adapter boundary.
- Do not add unrestricted sudo or Keychain access.
- Git commit/push is performed by the project owner, not by automation.
