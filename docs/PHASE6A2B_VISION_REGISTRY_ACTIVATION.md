# Phase 6A.2B — MiMo Vision Registry Activation

Phase 6A.2B activates the FLORAL-owned `floral_vision` MCP behind the canonical
Phase 4 MCP registry. It does **not** expose a third-party MiMo MCP directly.

## Runtime surface

`floral_vision` exposes exactly:

- `vision_analyze_screen`
- `vision_analyze_region`

Both remain approval-controlled and read-only. `required=false` means a vision
provider outage must not take down the main Codex/DeepSeek service.

## Secret handling

`MIMO_API_KEY` is represented in the federation as a SecretRef. The Codex MCP
projection contains only:

```toml
env_vars = ["MIMO_API_KEY"]
```

The key value is never stored in the MCP registry, native manifest, adoption
report, shadow report, or generated Codex config. Codex's stdio MCP launcher
copies the named variable from its own environment into the child process.

For the target Mac, put the key only in the untracked `.env`:

```text
MIMO_API_KEY=<your key>
```

## Fixed provider contract

This phase intentionally does not make the endpoint/model user-configurable:

```text
endpoint = https://api.xiaomimimo.com/v1
model    = mimo-v2.5
```

The server can read only canonical regular image files underneath:

```text
<FLORAL>/artifacts/outbound/floral_peekaboo
```

The existing input policy additionally rejects URLs, data URIs, raw base64,
symlinks, hardlinks, unsupported image extensions, and oversized files.

## Runner

The canonical registry launches the compiled FLORAL-owned server with the
current Node executable:

```text
node <FLORAL>/dist/scripts/floral-vision-mcp.js
```

This avoids depending on the Codex turn working directory or an `npx`/`tsx`
network resolution path.

## Next phase

6A.2B activates perception capability but does not yet claim an end-to-end
Peekaboo -> persisted screenshot -> MiMo pipeline. Phase 6A.3 should bind
Peekaboo capture results to provenance-checked artifacts under the allowed root
and exercise a real visual request through Codex/DeepSeek.
