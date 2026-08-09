# Phase 6A.4 — Trusted Inbound Vision

## Goal

Allow the FLORAL-owned MiMo vision MCP to analyze image attachments that the authenticated Feishu ingress path has already downloaded under FLORAL's private inbound data root.

## Trust domains

The vision server keeps two independent roots:

- `FLORAL_VISION_ALLOWED_ROOT`: FLORAL-generated Peekaboo screenshots.
- `FLORAL_VISION_INBOUND_ROOT`: user-provided Feishu image attachments materialized by FLORAL.

`vision_analyze_screen` and `vision_analyze_region` can only read the screenshot root. `vision_analyze_attachment` can only read the inbound attachment root. A path valid for one domain is rejected by the other.

## Input policy

Both domains reject URLs, data URIs, symlinks, hardlinks, non-regular files, empty files, files over the vision size ceiling, and unsupported image extensions. Real paths must remain inside the selected root.

Inbound images remain untrusted user content. The attachment tool explicitly tells MiMo not to follow instructions visible inside an image; such text may be reported as content but never gains tool or policy authority.

## Agent routing

The Gateway attachment manifest tells Codex/DeepSeek to use `floral_vision/vision_analyze_attachment` for image content instead of probing the file with shell commands or `view_image`. Ordinary files remain local attachments for normal Codex file-reading workflows.

## Out of scope

- Direct `input_image` support in the DeepSeek Responses bridge.
- Interactive-card media resources.
- Audio/video understanding.
- OCR as an independent service.
