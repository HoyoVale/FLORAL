# Remote Mac testing over Tailscale

1. Install Tailscale on Windows and the Mac mini and verify both devices are in the same tailnet.
2. Enable macOS Remote Login for the dedicated development user.
3. From Windows, run `ssh mac-user@mac-mini` using MagicDNS or the Tailscale IP.
4. Keep macOS Screen Sharing restricted to the tailnet and selected users when visual observation is needed.
5. Edit and run `scripts/test-mac.ps1`.

Remote test layers:

- SSH-only: install, typecheck, unit tests, build, Codex schema generation, logs.
- Logged-in GUI session: Peekaboo screenshots, UI tree, click/type smoke tests.
- Human-observed VNC: permission prompts and destructive-action approval flows.

The Mac must remain logged in for GUI automation. A headless daemon context is not equivalent to a user LaunchAgent context.
