#!/usr/bin/env bash
set -euo pipefail
[[ "$(uname -s)" == "Darwin" ]] || { echo "mac-smoke must run on macOS" >&2; exit 1; }

echo "== System =="
sw_vers
uname -m

echo "== Required commands =="
for cmd in node pnpm git codex tailscale; do
  command -v "$cmd" >/dev/null || { echo "missing: $cmd" >&2; exit 1; }
  "$cmd" --version 2>/dev/null | head -n 1 || true
done

echo "== Peekaboo =="
if command -v peekaboo >/dev/null; then
  peekaboo --version || true
else
  echo "Peekaboo not installed yet"
fi

echo "== Tailscale =="
tailscale status || true

echo "== Codex app-server schema smoke =="
rm -rf .codex-schemas-smoke
codex app-server generate-json-schema --out .codex-schemas-smoke
rm -rf .codex-schemas-smoke

echo "macOS smoke checks completed. GUI permissions still require manual validation."
