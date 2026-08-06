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

## Remote access boundary

Remote networking is external to FLORAL. Do not publish SSH, Screen Sharing, Codex WebSocket, or MCP ports directly to the public internet. Use a private authenticated network path and restrict access to the dedicated development user.

## Secrets

QQ AppSecret, DeepSeek API key, Better Auth secret, and any future OAuth tokens must never appear in source control, model prompts, audit payloads, or QQ replies.


## Identity and persistence

- Unknown QQ identities fail closed before a model turn is created.
- The owner pairing code must be random, at least 12 characters, and stored only outside Git.
- Pairing attempts are rate-limited and the code is never persisted.
- Duplicate transport message IDs are rejected before authorization and execution.
- Phase 3B accepts only verified C2C events; group and channel events fail closed.
- Passive reply targets are short-lived, bounded, and never reconstructed from guessed identifiers.
- Uncertain QQ delivery failures are not retried automatically, preventing duplicate replies.
- QQ SDK session-resume files remain local and are treated as credential-adjacent state.
- SQLite audit records store bounded event metadata only, never prompts, responses, credentials, reasoning, tool arguments, or tool result bodies.
- `/status` must not reveal OpenIDs, internal IDs, or Codex thread IDs.


## Managed provider runtime

- Real gateway mode generates a fresh random bridge token for each process.
- The bridge binds to loopback and uses an ephemeral port.
- Codex receives the bridge token but not the DeepSeek API key.
- Managed Codex home is mode 0700 and ignored by Git; its per-run configuration is mode 0600 and deleted during clean shutdown.
- Codex thread/session state is retained locally across restarts and must be included in backup/incident-response policy.
- Full-chain acceptance logs only bounded milestones and never user or provider content.
