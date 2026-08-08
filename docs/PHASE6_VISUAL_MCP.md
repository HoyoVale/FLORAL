# Phase 6 — macOS Visual MCP / Peekaboo

## Goal

Phase 6 turns FLORAL from a remote coding gateway into a macOS-observing Agent
without letting a GUI tool bypass FLORAL authorization or artifact-egress policy.

```text
Feishu user
  -> Gateway
  -> Codex / DeepSeek
  -> floral_peekaboo MCP
  -> macOS observation
  -> local result / screenshot
  -> AgentArtifact
  -> Outbound Egress Policy
  -> Feishu MediaTransport
```

Capture and remote delivery remain different authority decisions.

## Phase 6A.1 — observe-only Peekaboo MCP activation

6A.1 activates `floral_peekaboo` but exposes exactly:

```text
image
see
```

No click, type, shell, window mutation, dialog, app-control, agent, or workflow
tool is enabled.

Runtime:

```text
command = macos.peekaboo_command
args = ["mcp"]
stdio only
required = false
```

`required=false` is intentional for the first production activation: a visual
MCP startup problem must not take down Feishu/Codex entirely.

Peekaboo receives:

```text
PEEKABOO_ALLOW_TOOLS=image,see
PEEKABOO_AI_PROVIDERS=
PEEKABOO_LOG_LEVEL=warn
```

FLORAL/DeepSeek remains the model authority. Peekaboo must not independently
upload screenshots to another AI provider.

Both tools map to `screen.capture`. The 5F.4C egress policy separately requires
`message.send` before a resulting artifact may leave the Mac.

## Target-Mac baseline

Phase 6A.1 is pinned to Peekaboo `3.10.0`.

```bash
brew install steipete/tap/peekaboo
command -v peekaboo
peekaboo --version
```

For LaunchAgent reliability, put the actual absolute binary path in local
untracked `.env`:

```text
MACOS_MODE=real
PEEKABOO_COMMAND=/opt/homebrew/bin/peekaboo
```

Use `command -v peekaboo`; the example path is not portable.

Peekaboo 3.9.6+ changed signing identity. macOS may require Screen Recording,
Accessibility, and Automation grants to be re-confirmed after an upgrade.

## Isolation probe

Stop production first:

```bash
corepack pnpm service:stop
corepack pnpm peekaboo:probe
```

The probe verifies exact version, MCP subcommand, the exact `image,see` exposed
tool surface, permissions command, a temporary full-screen capture, and
`see --app Finder --json`. It never prints the `see` payload and deletes the
diagnostic screenshot before exit.

Expected tail:

```text
peekaboo.probe.version=3.10.0
peekaboo.probe.tools=image,see
peekaboo.probe.permissions_command=ok
peekaboo.probe.capture=ok
peekaboo.probe.see=ok
peekaboo.probe.ai_providers=disabled
peekaboo.probe.result=ok
```

## Production acceptance for 6A.1

After the probe passes:

```bash
corepack pnpm config:native:write
corepack pnpm config:native:check
corepack pnpm service:restart
corepack pnpm service:status
```

Then in Feishu:

```text
请只使用 floral_peekaboo/see 观察当前 Mac 屏幕/前台界面，
不要点击、输入或修改任何内容。告诉我你看到了什么。
```

6A.1 passes when the tool completes, no control tool is available, no GUI
mutation occurs, and the service remains ready.

6A.1 intentionally does not auto-send a screenshot yet.

## Phase 6A.2 — result-to-artifact adapter

6A.2 starts only after the real Codex app-server `mcpToolCall.result` shape has
been observed and validated. It will parse completed Peekaboo image/see results
without logging raw UI data, materialize eligible screenshots under
`artifacts/outbound`, emit provenance-bound `artifact.available`, and let the
existing 5F.4C policy decide whether Feishu may receive the image.

GUI control tools remain out of scope until Phase 6B has granular per-tool
capability and approval policy.
