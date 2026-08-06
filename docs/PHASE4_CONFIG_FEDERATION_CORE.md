# Phase 4.0B — Configuration Federation Core

Phase 4.0B establishes one typed configuration authority without changing the
production runtime yet. Existing services continue reading the current `.env`
and current hardcoded safety baseline until later renderer/adoption phases.

## Inputs and precedence

The authority resolves configuration in this order:

```text
compiled safe defaults
→ config/floral.toml requested configuration
→ explicit environment overrides
→ locked-field validation
→ cross-component validation
```

`config/floral.toml` contains only non-secret requested values. Secrets remain
in `.env` or the inherited process environment and are represented only as:

```json
{
  "kind": "environment",
  "name": "DEEPSEEK_API_KEY",
  "present": true
}
```

Secret values are never copied into requested/effective artifacts,
fingerprints, provenance, logs, or command output.

## Requested versus effective configuration

- **Requested configuration** is the normalized file plus compiled defaults.
- **Effective configuration** applies only environment variables that are
  explicitly present and records their provenance.
- `requestedFingerprint` and `effectiveFingerprint` are separate stable SHA-256
  values.
- Secret fingerprints intentionally depend only on presence, not secret value.

Every effective leaf records whether it came from a default, the configuration
file, or an environment variable. The Phase 4.0A catalog supplies the ownership
classification associated with environment-backed fields.

## Locked safety fields

The following fields cannot be changed before Phase 4P introduces a real
permission and approval authority:

```text
codex.native_web_search=false
codex.sandbox.mode=read-only
codex.approval.policy=never
auth.email_password_enabled=false
mcp.*.inherit_parent_environment=false
```

Unknown keys and locked-field overrides fail before any production component is
started.

## Constrained FLORAL TOML

The repository does not add a new parser dependency in this phase. The local
parser deliberately supports only the subset required by `config/floral.toml`:

- dotted tables;
- bare keys;
- double-quoted strings;
- booleans;
- finite integers;
- scalar arrays.

It is not used to parse or render Codex, SearXNG, or other upstream native
configuration. Later component adapters own those formats.

## Commands

Validate and show the safe summary:

```bash
corepack pnpm config:validate
corepack pnpm config:show
```

Print the complete redacted authority as JSON:

```bash
corepack pnpm config:effective
```

Write private effective artifacts:

```bash
corepack pnpm config:effective:write
```

Artifacts are written atomically under:

```text
data/config/effective/
  floral-requested.json
  floral-effective.json
  manifest.json
```

The directory is mode `0700`; files are mode `0600`; Git ignores the directory.

## Non-goals

Phase 4.0B does not:

- replace `loadEnv()` in the production gateway;
- render Codex `config.toml` or `requirements.toml`;
- render SearXNG `settings.yml`;
- change QQ SDK constructor options;
- enable native passthrough;
- enable MiMo or Peekaboo MCP;
- make sandbox or approval configurable.

Those changes require native adapters, deterministic renderers, drift checks,
and the Phase 4P authorization authority.
