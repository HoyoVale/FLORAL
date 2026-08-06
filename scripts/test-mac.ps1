$ErrorActionPreference = "Stop"

# Optional generic SSH helper. Remote networking is external to FLORAL.
$MacHost = "mac-user@mac-mini"
$Project = "~/Projects/mac-agent-gateway"
$ArtifactDestination = Join-Path $PSScriptRoot "..\artifacts-macos"

Write-Host "Testing $Project on $MacHost"

ssh $MacHost @"
set -euo pipefail
cd $Project
git status --short
corepack pnpm install --frozen-lockfile
corepack pnpm bootstrap:validate
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm qq:sdk:check
corepack pnpm storage:probe
mkdir -p artifacts
corepack pnpm doctor > artifacts/doctor.txt 2>&1 || true
corepack pnpm storage:doctor > artifacts/storage-doctor.txt 2>&1 || true
if [ "`$(uname -s)" = "Darwin" ]; then
  bash scripts/mac-smoke.sh > artifacts/mac-smoke.txt 2>&1 || true
fi
"@

if ($LASTEXITCODE -ne 0) { throw "Remote Mac test failed" }

Remove-Item -Recurse -Force $ArtifactDestination -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $ArtifactDestination | Out-Null
scp -r "${MacHost}:${Project}/artifacts/." $ArtifactDestination
Write-Host "Remote Mac test complete. Artifacts: $ArtifactDestination"
