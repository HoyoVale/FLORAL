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

Phase 4.0C renders the native upstream configuration bundle. Phase 4.0D then
compares requested, effective, rendered, installed, and observed state. Phase
4.0E1 validates the Codex renderer in shadow mode, Phase 4.0E2 performs the
controlled Codex-only production cutover, Phase 4.0E3 adopts the canonical
MCP registry, Phase 4.0E4 adopts QQ SDK runtime options, and Phase 4.0E5 adopts
SearXNG runtime preparation and bounded `/config` observation:

```bash
corepack pnpm config:native
corepack pnpm config:native:json
corepack pnpm config:native:check
corepack pnpm config:native:write
corepack pnpm config:diagnostics
corepack pnpm config:diagnostics:check
corepack pnpm config:diagnostics:write
corepack pnpm config:cutover:check
corepack pnpm config:explain -- codex.native.reasoning_effort
corepack pnpm config:codex-shadow
corepack pnpm config:codex-shadow:check
corepack pnpm config:codex-cutover
corepack pnpm config:codex-cutover:check
corepack pnpm config:mcp-adoption
corepack pnpm config:mcp-adoption:check
corepack pnpm config:qq-adoption
corepack pnpm config:qq-adoption:check
corepack pnpm config:searxng-adoption
corepack pnpm config:searxng-adoption:check
```

See `docs/PHASE4_NATIVE_CONFIG_RENDERERS.md` for the Codex, SearXNG, QQ SDK,
and MCP artifact contracts, `docs/PHASE4_CONFIG_DRIFT_DIAGNOSTICS.md` for
the drift report and controlled cutover gate, and
`docs/PHASE4_CODEX_SHADOW_ADOPTION.md` for the fail-open Codex shadow rollout,
and `docs/PHASE4_CODEX_CONTROLLED_CUTOVER.md` for atomic unified activation
and one-shot legacy rollback. See `docs/PHASE4_MCP_REGISTRY_ADOPTION.md` for
the canonical MCP registry, runtime projection check, and adoption report. See
`docs/PHASE4_QQ_RUNTIME_OPTIONS_ADOPTION.md` for QQ constructor/session/delivery
adoption and one-shot legacy recovery. See
`docs/PHASE4_SEARXNG_RUNTIME_PREPARATION_ADOPTION.md` for unified SearXNG
preparation, reviewed image validation, bounded runtime observation, and legacy
recovery.

Phase 5.1 adds a durable fail-closed DeepSeek cost guard after the provider
request boundary was observed to self-call under runaway agent behavior:

```bash
corepack pnpm cost:status
corepack pnpm cost:check
corepack pnpm cost:json
```

The guard enforces rolling request/token/estimated-cost budgets and duplicate
request limits before another provider attempt is allowed. See
`docs/PHASE5_AGENT_COST_GUARD.md`.

Phase 5.2 adds the FLORAL-owned authorization authority and owner-scoped,
one-shot QQ approval broker without relaxing the production read-only Codex
sandbox:

```bash
corepack pnpm policy:status
corepack pnpm policy:check
```

Remote approval commands are `/approve <id>` and `/deny <id>`. Grants expire,
are bound to the current owner and conversation, are consumed once, and vanish
on service restart. Opaque Codex command escalation and system administration
remain Mac-local only. See `docs/PHASE5_AUTHORIZATION_APPROVAL_AUTHORITY.md`.

Phase 5.3 activates Codex deterministic user-reviewed approval handling with a
cwd-only, network-disabled workspace-write turn sandbox while retaining the
native read-only/never fail-safe. FLORAL translates its `untrusted` policy to
the pinned app-server wire value `unlessTrusted`. A concrete Codex file-change
request may receive one
owner/conversation-bound QQ grant; opaque command escalation still requires an
independent Mac-local confirmation. Local confirmations use a private,
service-session-bound mailbox under the FLORAL runtime directory and can be
resolved only from the Mac:

```bash
corepack pnpm approval:local:list
corepack pnpm approval:local:approve -- <id>
corepack pnpm approval:local:deny -- <id>
```

No approval is promoted to session scope. See
`docs/PHASE5_CONTROLLED_CAPABILITY_ACTIVATION.md`.

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
