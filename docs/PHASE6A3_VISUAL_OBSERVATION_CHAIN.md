# Phase 6A.3 — Controlled Visual Observation Chain

## Status

Implementation package for the next FLORAL visual-observation stage.

Phase 6A.2 proved the FLORAL-owned MiMo vision MCP end to end. Phase 6A.3 closes the remaining trust gap between Peekaboo capture and the vision adapter.

## Why the raw Peekaboo MCP is no longer exposed directly

Peekaboo 3.10.0's upstream `image` and `see` tools accept caller-selected output paths. `image` also exposes inline/base64 output, optional upstream AI analysis, and foreground focus behavior.

Those are useful generic Peekaboo features, but they are broader than FLORAL's observe-only policy.

Phase 6A.3 therefore keeps the Codex server ID and tool names:

- `floral_peekaboo/image`
- `floral_peekaboo/see`

but changes their transport to a FLORAL-owned MCP gateway.

## Gateway policy

The FLORAL gateway:

- generates every screenshot path under `artifacts/outbound/floral_peekaboo`;
- returns the canonical `artifactPath` to the model;
- fixes capture format to PNG;
- fixes image capture focus to background;
- fixes image scale to logical 1x;
- caps image longest dimension at 1920;
- disables Peekaboo AI providers;
- never accepts `question`, raw/base64 output, arbitrary `path`, foreground focus, or annotation from the model;
- fixes `see` traversal budgets;
- checks the upstream advertised tool surface is exactly `image,see`;
- launches the upstream Peekaboo process with a small explicit non-secret environment.

The existing `floral_vision` MCP then accepts only files under the same trusted root.

## Model routing contract

`floral_peekaboo/see` is preferred when accessibility/UI structure is enough.

When pixel semantics, rendered content, OCR, charts, images, canvas content, or visual error interpretation are required:

1. call `floral_peekaboo/image` (or use the artifact from `see`);
2. read the returned `artifactPath`;
3. call `floral_vision/vision_analyze_screen` with that exact path;
4. continue reasoning in DeepSeek from the returned text.

The tool descriptions encode this routing contract so the primary text model can perform the sequence in a single Codex turn.

## Probe

`pnpm visual-chain:probe` runs a real macOS production probe:

1. launches the FLORAL Peekaboo gateway;
2. confirms only `image,see` are advertised;
3. captures a real screenshot to the trusted artifact root;
4. validates the artifact with the FLORAL vision input policy;
5. launches `floral_vision`;
6. sends the screenshot to MiMo v2.5;
7. validates a non-empty text response;
8. deletes the probe screenshot.

The probe does not print the screenshot or MiMo response text. It prints only byte count, response length, and SHA-256.

**Privacy note:** this probe sends one live screenshot through the configured MiMo API. Run it only when the visible screen is appropriate for the configured vision provider.

## Phase boundary

Phase 6A.3 remains observation-only.

It does not enable:

- click
- type
- scroll
- drag
- shell
- app launch/control
- browser submission

Those remain Phase 6B+ work and require a separate authorization review.
