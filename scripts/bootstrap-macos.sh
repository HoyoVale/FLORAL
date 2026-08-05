#!/usr/bin/env bash
set -euo pipefail

[[ "$(uname -s)" == "Darwin" ]] || { echo "This script must run on macOS" >&2; exit 1; }

echo "Mac Agent environment check"
sw_vers

action_required=0
check() {
  local command="$1"
  if command -v "$command" >/dev/null 2>&1; then
    printf '✓ %s\n' "$command"
  else
    printf '✗ %s missing\n' "$command"
    action_required=1
  fi
}

check git
check node
check corepack

if command -v pnpm >/dev/null 2>&1; then
  printf '✓ pnpm\n'
elif command -v corepack >/dev/null 2>&1 && corepack pnpm --version >/dev/null 2>&1; then
  printf '✓ pnpm (via corepack)\n'
else
  printf '✗ pnpm missing and corepack fallback unavailable\n'
  action_required=1
fi

check codex
check peekaboo

cat <<'MANUAL'

Manual macOS steps:
1. Keep the intended GUI user logged in.
2. Grant Peekaboo/host app Screen Recording and Accessibility access.
3. Configure the Codex model provider in ~/.codex/config.toml.
4. Add Peekaboo as a local stdio MCP server in ~/.codex/config.toml.
5. Run foreground smoke tests before installing the LaunchAgent.
MANUAL

if [[ "$action_required" -ne 0 ]]; then
  cat <<'SUGGESTED'

Suggested installation commands (review before running):
  xcode-select --install
  brew install node@24 git
  curl -fsSL https://chatgpt.com/codex/install.sh | sh
  brew install steipete/tap/peekaboo

pnpm does not need a global shim when `corepack pnpm` works in this project.
SUGGESTED
  exit 2
fi

echo "All command-line prerequisites found."
