# Mac Agent Gateway — development bootstrap

A deliberately thin Node.js/TypeScript gateway for this architecture:

```text
QQ Open Platform
        ↓
QQ transport adapter
        ↓
identity / policy / approval / audit
        ↓
Codex app-server (agent harness)
        ↓
configured model provider / future bridge
        ↓
Peekaboo MCP (macOS GUI automation)
```

This bundle is a **development baseline**, not a finished remote-control product. It starts in mock mode so Windows development can begin before QQ credentials, Codex configuration, macOS permissions, and Peekaboo are ready.

## Recommended environments

- Development PC: Windows 10/11, Node.js 22+, pnpm through Corepack, Git, and PowerShell 7.
- Target: macOS 15+, logged-in dedicated user, Node.js 22+, pnpm through Corepack, Codex CLI, and Peekaboo.
- Remote connectivity is optional and external to FLORAL; keep Codex app-server and Peekaboo local to the Mac.

## Start locally on Windows

```powershell
Copy-Item .env.example .env
corepack pnpm install
corepack pnpm bootstrap:validate
corepack pnpm doctor
corepack pnpm test
corepack pnpm dev
```

The default `QQ_MODE=mock` exposes a terminal chat loop. Type a message and the mock agent echoes a deterministic response. This validates configuration, message routing, and shutdown behavior without contacting any external service.

## Inspect the unified configuration authority

Phase 4.0B keeps production behavior unchanged while resolving the requested
`config/floral.toml` and explicit `.env` overrides into one redacted effective
configuration:

```bash
corepack pnpm config:validate
corepack pnpm config:show
corepack pnpm config:effective:write
```

See `docs/PHASE4_CONFIG_FEDERATION_CORE.md` for precedence, locked fields,
SecretRef handling, fingerprints, and the non-goals of this phase.

## Prepare the Mac mini

Copy or clone the project onto the Mac and run:

```bash
chmod +x scripts/*.sh
./scripts/bootstrap-macos.sh
cp .env.example .env
corepack pnpm install
corepack pnpm doctor
corepack pnpm mac:smoke
```

Then configure, in order:

1. Codex CLI and a validated provider configuration.
2. Peekaboo and macOS Screen Recording + Accessibility permissions.
3. QQ bot AppID/AppSecret.
4. `QQ_MODE=real`, `CODEX_MODE=real`, `MACOS_MODE=real`.
5. LaunchAgent only after foreground smoke tests pass.

## Remote test from Windows

Edit the variables at the top of `scripts/test-mac.ps1`, then run:

```powershell
./scripts/test-mac.ps1
```

The optional script uses generic SSH, runs validation/build/tests on the Mac, and copies `artifacts/` back to Windows. Networking and host reachability are managed outside this project.

## Important boundary

Codex app-server is currently an experimental integration surface. The project keeps it behind `AgentRuntime`, records the Codex version, and includes schema generation so protocol changes remain isolated.

See `docs/CODEX_APP_SERVER_PHASE1.md`, `docs/ENVIRONMENT_SETUP.md`, `docs/SECURITY_BASELINE.md`, and `docs/IMPLEMENTATION_ROADMAP.md` before enabling real machine control.
