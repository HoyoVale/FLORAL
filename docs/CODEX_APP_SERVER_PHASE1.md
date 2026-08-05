# Codex App Server Phase 1

This phase turns the existing process wrapper into a tested App Server runtime while keeping mock-mode development available on Windows.

## Runtime lifecycle

```text
spawn codex app-server
→ initialize
→ initialized
→ thread/start or thread/resume
→ turn/start
→ item and delta notifications
→ item/completed (authoritative item result)
→ turn/completed (terminal turn status)
```

A Codex thread is loaded once per App Server process. A persisted thread id from an earlier process is resumed before the next turn starts.

## Safety posture

Phase 1 starts and runs turns with a read-only sandbox and `approvalPolicy: never`. Server-initiated command and file-change approvals are nevertheless handled defensively and declined. Permission requests receive an empty granted subset, and MCP elicitations are declined.

This is an execution baseline, not the final interactive approval UX. Later phases must route reviewable requests through the policy and chat-confirmation layer before any write or GUI-control capability is enabled.

## Final text

Streaming `item/agentMessage/delta` notifications are forwarded as progress. The final result prefers the completed `agentMessage` item, then the final agent message included in `turn/completed`, and only falls back to concatenated deltas.

## Errors

`CodexRuntimeError` classifies:

- usage or session limits
- authentication failures
- upstream network/stream failures
- bad requests and sandbox errors
- provider/internal failures
- request and turn timeouts
- App Server process exits
- malformed protocol messages
- interrupted turns

The real probe treats `usage_limit` as proof that the local App Server protocol reached the configured provider, while still reporting that no model answer was produced.

## Commands

Windows and CI use the Fake App Server tests:

```powershell
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

On the Mac target:

```bash
corepack pnpm mac:smoke
corepack pnpm codex:probe
```
