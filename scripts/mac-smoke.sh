#!/usr/bin/env bash
set -euo pipefail
[[ "$(uname -s)" == "Darwin" ]] || { echo "mac-smoke must run on macOS" >&2; exit 1; }

pnpm_cmd=()
if command -v pnpm >/dev/null 2>&1; then
  pnpm_cmd=(pnpm)
elif command -v corepack >/dev/null 2>&1; then
  pnpm_cmd=(corepack pnpm)
else
  echo "missing: pnpm (and no corepack fallback available)" >&2
  exit 1
fi

echo "== System =="
sw_vers
uname -m

echo "== Required commands =="
for cmd in node git codex tailscale; do
  command -v "$cmd" >/dev/null || { echo "missing: $cmd" >&2; exit 1; }
  "$cmd" --version 2>/dev/null | head -n 1 || true
done

printf 'pnpm: '
"${pnpm_cmd[@]}" --version

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
