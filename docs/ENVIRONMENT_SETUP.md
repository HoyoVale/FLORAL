# Environment setup

## Windows development machine

Install Node.js 22 or newer, Git, and PowerShell 7. Use pnpm through Corepack. An SSH client is optional and only needed for remote Mac maintenance. Run `scripts/bootstrap-windows.ps1` from the repository root.

The Windows machine develops and tests all transport, identity, policy, database, and Codex protocol code. It uses mock QQ, mock Agent, and mock macOS adapters by default.

## Mac mini target

Recommended baseline:

- macOS 15 or later for current Peekaboo releases
- dedicated non-admin or constrained user for the Agent
- the user remains logged in when GUI control is required
- Node.js 22 or newer
- Git and pnpm through Corepack
- Codex CLI
- Peekaboo

Run `scripts/bootstrap-macos.sh`. It performs checks only and prints reviewed installation commands; it does not silently install or grant permissions.

## Codex protocol preparation

Run `corepack pnpm codex:schema` on the target Mac after installing/updating Codex. Commit neither generated schemas nor secrets. Use the generated version marker when adapting to protocol changes.

## QQ preparation

Create an official QQ bot, record AppID/AppSecret, and keep mock mode until the bot can receive and send a private test message. Configure `QQ_MODE=real` only on the Mac or a secured integration environment.

## Better Auth preparation

The first private QQ-only MVP may bind QQ OpenID directly and keep `AUTH_MODE=local`. Better Auth becomes active when a web admin or independent account/session surface is introduced. It is already included to avoid a later identity migration.

## GUI permissions

Foreground tests must pass before launchd installation. Grant the stable host executable/app:

- Screen Recording
- Accessibility
- Automation when Apple Events are used
- Full Disk Access only when a concrete requirement exists

Permissions cannot be granted remotely by a script without undermining macOS security.
