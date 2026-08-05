# Remote Mac testing

Remote connectivity is deliberately outside FLORAL's runtime dependencies. Use any private, authenticated path that fits the environment, or operate the Mac locally.

For optional SSH-based testing:

1. Enable macOS Remote Login only for the dedicated development user.
2. Confirm the chosen private network path can reach TCP port 22.
3. From Windows, run `ssh mac-user@mac-host`.
4. Restrict Screen Sharing to selected users when visual observation is needed.
5. Edit and run `scripts/test-mac.ps1` only when remote automation is useful.

Remote test layers:

- SSH-only: install, typecheck, unit tests, build, Codex schema generation, logs.
- Logged-in GUI session: Peekaboo screenshots, UI tree, click/type smoke tests.
- Human-observed screen sharing: permission prompts and destructive-action approval flows.

The Mac must remain logged in for GUI automation. A headless daemon context is not equivalent to a user LaunchAgent context.
