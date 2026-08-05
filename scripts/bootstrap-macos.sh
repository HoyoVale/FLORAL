#!/usr/bin/env bash
set -euo pipefail

[[ "$(uname -s)" == "Darwin" ]] || { echo "This script must run on macOS" >&2; exit 1; }

echo "Mac Agent environment check"
sw_vers

action_required=0
check() {
  local command="$1"; shift
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
check pnpm
check tailscale
check codex
check peekaboo

cat <<'EOF'

Manual macOS steps:
1. Enable System Settings → General → Sharing → Remote Login.
2. Keep the intended GUI user logged in.
3. Grant Peekaboo/host app Screen Recording and Accessibility access.
4. Configure Codex + DeepSeek using DeepSeek's official setup script.
5. Add Peekaboo as a local stdio MCP server in ~/.codex/config.toml.
6. Run foreground smoke tests before installing the LaunchAgent.
EOF

if [[ "$action_required" -ne 0 ]]; then
  cat <<'EOF'

Suggested installation commands (review before running):
  xcode-select --install
  brew install node@24 pnpm git
  curl -fsSL https://chatgpt.com/codex/install.sh | sh
  brew install steipete/tap/peekaboo

Install Tailscale using the official standalone macOS package, then sign in.
EOF
  exit 2
fi

echo "All command-line prerequisites found."
