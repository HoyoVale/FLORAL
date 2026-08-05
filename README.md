# FLORAL Codex sandbox enum hotfix

Baseline:

```text
f76e78dc267da1d607230e4e94e07981c672e74b
```

This hotfix updates the Codex App Server sandbox enum from the obsolete camelCase value:

```text
readOnly
```

to the value required by Codex CLI 0.146.1:

```text
read-only
```

It updates both `thread/start` and `turn/start`, then makes the Fake App Server reject future regressions.

## Apply on Windows

```powershell
PowerShell -ExecutionPolicy Bypass -File .\apply.ps1 `
  -RepoRoot "C:\path\to\FLORAL"
```

## Validate on Windows

```powershell
cd C:\path\to\FLORAL
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
git diff --check
git status --short
```

Commit and push manually after validation.

## Validate on Mac after pulling

```bash
cd /Volumes/WORK_1TB/FLORAL
git fetch --prune origin
git reset --hard origin/main
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm mac:smoke
corepack pnpm codex:probe
```

With no model quota, the expected probe result is a typed usage-limit result rather than a protocol failure.

## Windows PowerShell compatibility

This v2 script treats Git's LF/CRLF message as a warning and checks the native process exit code, so Windows PowerShell 5.1 does not abort on a harmless `NativeCommandError`.
