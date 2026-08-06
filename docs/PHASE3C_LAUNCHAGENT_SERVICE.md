# Phase 3C — LaunchAgent service and crash recovery

## Boundary

FLORAL runs as a per-user LaunchAgent. It is intentionally not a root daemon.
The intended GUI user must remain logged in for QQ, Codex, and future GUI
automation permissions.

The generated plist contains paths and non-secret runtime settings only.
QQ, DeepSeek, pairing, and future administration secrets remain in the local
repository `.env`. The project may live on an external volume, but launchd-owned
working and log paths are always created on the internal user volume.

## Security prerequisites

Before installation:

```bash
cd /Volumes/WORK_1TB/FLORAL
chmod 600 .env
corepack pnpm build
corepack pnpm service:doctor
```

`service:doctor` fails closed unless:

- the host is macOS;
- `dist/src/main.js` and the compiled runner exist;
- `.env` is a regular owner-only file;
- `QQ_MODE=real`;
- `CODEX_MODE=real`;
- `MOCK_TRUST_OWNER=false`;
- Node, Codex, and `npx` are executable;
- the loopback SearXNG endpoint returns valid results.

No secret is written into `~/Library/LaunchAgents`.

## Lifecycle

Install and start:

```bash
corepack pnpm service:install
```

Routine commands:

```bash
corepack pnpm service:status
corepack pnpm service:logs
corepack pnpm service:restart
corepack pnpm service:stop
corepack pnpm service:start
```

Uninstall the LaunchAgent while preserving local data:

```bash
corepack pnpm service:uninstall
```

Uninstall does not delete `.env`, SQLite, QQ session state, Codex threads, or
logs.

## Single-instance rule

The main process atomically owns:

```text
data/floral.lock
```

A second foreground or LaunchAgent instance fails before opening the Gateway.
If the previous process was killed, the next process verifies the recorded PID
and safely removes the stale lock.

## State and diagnostics

LaunchAgent mode writes bounded metadata to:

```text
data/service-state.json
```

It contains only:

- schema version;
- lifecycle phase;
- process PID;
- random instance identifier;
- start/update timestamps;
- error class name when startup fails.

It does not contain prompts, replies, OpenIDs, credentials, pairing codes,
thread IDs, tool results, or reasoning.

## Internal runtime and logs

The LaunchAgent does not use the repository as its own working directory. The
installer creates an owner-only internal runtime directory:

```text
~/Library/Application Support/FLORAL/runtime
```

The runner captures the application streams and rotates them under:

```text
~/Library/Logs/FLORAL/service.out.log
~/Library/Logs/FLORAL/service.err.log
```

Defaults:

- 5 MiB per active file;
- five backups;
- owner-only files.

Launchd itself writes only the supervisor's small lifecycle stream to:

```text
~/Library/Logs/FLORAL/launchagent.supervisor.out.log
~/Library/Logs/FLORAL/launchagent.supervisor.err.log
```

The installer creates these directories and files before `launchctl bootstrap`,
with `0700` directories and `0600` logs. This avoids macOS `EX_CONFIG` failures
when the repository is located on `/Volumes/...`.

## Crash recovery acceptance

After installation and a successful `service:status`:

```bash
corepack pnpm service:recovery:probe
```

The probe sends `SIGKILL` only to the current FLORAL application child. The
runner exits non-zero, launchd applies its throttle, and a new instance must
reach `ready` with a different PID.

Expected:

```text
service.recovery.old_pid=<pid>
service.recovery.new_pid=<different-pid>
service.recovery.result=ok
```

Then send a QQ message and verify the normal full chain still replies.


## Test discovery boundary

The persistent Codex home may contain downloaded plugin fixtures and third-party
files whose names end in `.test.ts`, `.test.js`, or `.test.mjs`. They are runtime
data, not FLORAL's test suite.

`vitest.config.ts` therefore limits collection to:

```text
tests/**/*.test.ts
```

Do not delete `data/codex-runtime` to make tests pass; that directory carries
the Codex thread/session state validated in Phase 3B.2.

## Upgrade procedure

Do not edit the installed plist manually.

```bash
git fetch --prune origin
git reset --hard origin/main
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm service:doctor
# Reinstall regenerates absolute Node/Codex paths after toolchain upgrades.
corepack pnpm service:install
corepack pnpm service:status
```

A failed build or doctor check blocks restart. If readiness still times out, the
service command prints the current service state, a bounded launchctl summary
(including `last exit code`), and bounded supervisor/application stderr tails.
