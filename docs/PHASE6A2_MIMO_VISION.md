# Phase 6A.2 — MiMo Vision gateway

## Decision

Do not expose a third-party MiMo vision MCP directly to Codex.

Audited community servers accept arbitrary local paths and/or remote URLs; one implementation also accepts raw base64/data URIs and exposes clipboard capture. That tool surface is wider than FLORAL's read-only visual-observation policy.

FLORAL therefore owns the MCP boundary:

`DeepSeek/Codex -> floral_vision -> trusted FLORAL screenshot artifact -> MiMo Vision API -> text observation`

## Exposed tools

- `vision_analyze_screen`
- `vision_analyze_region`

Both accept only a screenshot path that resolves beneath `FLORAL_VISION_ALLOWED_ROOT`.

Forbidden inputs:

- HTTP/HTTPS image URLs
- data URIs
- raw base64
- paths outside the FLORAL screenshot root
- symlinks
- hardlinks
- non-regular files
- unsupported image extensions
- files larger than 25 MiB

`vision_analyze_region` currently uses normalized coordinates as a focus hint against the same trusted image; it does not open a second path or invoke a local crop command.

## Secret boundary

The MCP process expects `MIMO_API_KEY`, but production runtime must inject it from FLORAL's SecretRef resolver. The MCP must not inherit the parent process environment.

The registry projection should explicitly inject only:

- `MIMO_API_KEY` from SecretRef
- `MIMO_BASE_URL`
- `MIMO_VISION_MODEL`
- `FLORAL_VISION_ALLOWED_ROOT`

The Codex-rendered MCP config must never contain the secret literal.

## Rollout

Initial production registry state:

- server id: `floral_vision`
- enabled: true only when `config.mcp.vision.enabled=true`
- required: false
- tools: `vision_analyze_screen`, `vision_analyze_region`
- approval mode: approve
- no network/image input tool beyond the two FLORAL wrappers

## Version baselines

- Peekaboo: `3.10.0`
- FLORAL vision gateway: `0.1.0`
- MiMo model default: `mimo-v2.5`

Peekaboo `3.10.0` was verified from `steipete/tap/peekaboo`, upstream repository `openclaw/Peekaboo`, release build `893bc9412` built 2026-08-05.
