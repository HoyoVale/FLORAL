# Security baseline

This system can control a real computer. Treat every inbound message, model output, webpage, attachment, and tool result as untrusted input.

## Required controls before real mode

- Bind only official QQ OpenID values obtained from verified events.
- Initialize the owner with a local one-time pairing code.
- Reject unknown users and group contexts by default.
- Keep Codex app-server on local stdio; never expose it directly to the internet.
- Keep Peekaboo on local MCP stdio.
- Run the gateway as a normal logged-in macOS user, never root.
- Require chat confirmation for destructive or externally visible operations.
- Require local confirmation for sudo, security settings, account management, Keychain, disk erasure, shutdown, and restart.
- Record user request, thread/turn IDs, command summaries, file changes, approval decisions, and results.
- Provide a local emergency stop command and disable the LaunchAgent before debugging permission loops.

## Tailscale

Use Tailscale only as the private network path. Standard macOS SSH can run over the Tailscale IP/MagicDNS name. Do not publish SSH, VNC, Codex WebSocket, or MCP ports to the public internet.

## Secrets

QQ AppSecret, DeepSeek API key, Better Auth secret, and any future OAuth tokens must never appear in source control, model prompts, audit payloads, or QQ replies.
