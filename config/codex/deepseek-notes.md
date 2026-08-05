# DeepSeek provider notes

Use DeepSeek's official Codex setup script rather than copying a stale model catalog into this repository. The script backs up `~/.codex/config.toml`, writes the matching `models.json`, and preserves existing MCP/trust settings.

As of 2026-08-06, DeepSeek's official documentation confirms `deepseek-v4-flash` for Codex. Verify the documentation again before enabling another model.

Keep API keys in the target user's protected Codex configuration or a secret store. Do not commit them to this repository or inject them into QQ messages/logs.
