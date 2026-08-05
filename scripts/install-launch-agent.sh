#!/usr/bin/env bash
set -euo pipefail

[[ "$(uname -s)" == "Darwin" ]] || { echo "macOS required" >&2; exit 1; }
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_PATH="$(command -v node)"
TEMPLATE="$PROJECT_DIR/launchd/com.hoyo.mac-agent.plist.template"
TARGET="$HOME/Library/LaunchAgents/com.hoyo.mac-agent.plist"
mkdir -p "$HOME/Library/LaunchAgents" "$PROJECT_DIR/logs"

sed \
  -e "s|__PROJECT_DIR__|$PROJECT_DIR|g" \
  -e "s|__NODE_PATH__|$NODE_PATH|g" \
  "$TEMPLATE" > "$TARGET"

plutil -lint "$TARGET"
launchctl bootout "gui/$(id -u)" "$TARGET" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$TARGET"
launchctl kickstart -k "gui/$(id -u)/com.hoyo.mac-agent"
echo "Installed: $TARGET"
