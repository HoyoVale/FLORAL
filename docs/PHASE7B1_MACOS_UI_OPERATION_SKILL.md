# Phase 7B.1 — macOS UI Operation Skill

This phase moves the already-validated FLORAL macOS GUI workflow into Codex's native Skill layer.

It reuses `floral_peekaboo/see`, `floral_peekaboo/image`, `floral_vision/vision_analyze_screen`, `floral_peekaboo/click`, existing host-side approval, and `floral_delivery/send_artifact`.

The mutation state machine is:

`see → establish target → one approval-gated click → see again`

Vision may assist understanding but never replaces a fresh `see` as mutation authority. Unsupported GUI mutations must be reported rather than bypassed through shell, AppleScript, coordinates, or direct Peekaboo CLI.

Natural-language requests may be selected by Codex automatically. Explicit use is available as `$macos-ui-operation ...`. `/skills` should list the Skill after deployment.
