# Phase 4.0C — Native Configuration Adapters and Deterministic Renderers

Phase 4.0C converts the redacted effective FLORAL configuration into native,
component-specific artifacts without switching the production runtime to those
artifacts yet.

The phase covers four active configuration domains:

```text
Codex config.toml and requirements preview
SearXNG compose.yaml and settings.yml
QQ SDK constructor and delivery-policy contract
MCP server, transport, tool, timeout, and approval manifest
```

## Why this phase is separate from runtime adoption

The same requested setting can map to different upstream formats and defaults.
Rendering first gives FLORAL a deterministic, reviewable contract before the
existing runtime readers are replaced. This avoids changing service behavior
while configuration drift is still being discovered.

The rendered Codex configuration contains a runtime placeholder for the
short-lived DeepSeek bridge URL:

```text
__FLORAL_BRIDGE_BASE_URL__
```

The rendered SearXNG settings contain a runtime-only secret placeholder:

```text
__FLORAL_SEARXNG_SECRET__
```

Neither placeholder is a secret. Phase 4.0D will compare generated, installed,
and observed configurations; a later adoption phase will perform controlled
runtime substitution.

## Managed native fields

### Codex

The typed FLORAL configuration now includes:

- provider ID and Responses wire protocol;
- Codex-native reasoning effort and reasoning summary;
- deterministic `high -> high` and `max -> xhigh` provider-to-Codex mapping
  when native reasoning is set to `inherit`;
- native web-search mode;
- provider retry and WebSocket declarations;
- sandbox and approval values;
- MCP command, arguments, environment, allowlist, timeouts, and approval modes.

The generated `requirements.toml` is a preview only. Phase 4.0C does not install
an administrator-enforced requirements file.

### SearXNG

The typed configuration now owns the pinned image, loopback host binding,
container lifecycle and health-check values, and the currently managed
`settings.yml` surface. Checked-in `infra/searxng/compose.yaml` and
`settings.template.yml` must exactly match the renderer.

SearXNG still inherits upstream defaults through `use_default_settings`. Engine
and plugin effective defaults remain an observed-runtime item for Phase 4.0D.

### QQ SDK

The generated JSON records the pinned package version, account-ID strategy,
session persistence, token-prefetch mode, redacted logger policy, and FLORAL
message-delivery limits. Credentials are represented only by environment
variable names.

### MCP

The generated manifest separates:

```text
transport configuration
provider configuration
tool allowlist
timeouts
approval metadata
parent-environment inheritance
```

Planned MiMo and Peekaboo servers remain disabled and are recorded only as
planned manifests.

## Commands

Show hashes and artifact state:

```bash
corepack pnpm config:native
```

Print the redacted manifest as JSON:

```bash
corepack pnpm config:native:json
```

Check deterministic rendering, checked-in SearXNG drift, QQ package-version
drift, duplicate artifact paths, and secret leakage:

```bash
corepack pnpm config:native:check
```

Write private artifacts:

```bash
corepack pnpm config:native:write
```

The output is written through a staged directory swap with private permissions:

```text
data/config/native/
  codex/config.toml
  codex/model-catalog.json
  codex/requirements.toml
  searxng/compose.yaml
  searxng/settings.yml
  qq/sdk-options.json
  mcp/manifest.json
  manifest.json
```

Directories use mode `0700`, files use mode `0600`, and Git ignores the output.

## Security and non-goals

Phase 4.0C does not:

- put secret values into rendered artifacts;
- modify the user's normal `~/.codex/config.toml`;
- install Codex admin requirements;
- replace the production environment reader;
- enable native Codex web search;
- enable MiMo or Peekaboo;
- weaken read-only sandbox or never-approve policy;
- expose native passthrough keys.

The next phase is Phase 4.0D: installed/effective drift diagnostics and upstream
runtime observation.
