$ErrorActionPreference = "Stop"

# Edit these values for your Tailscale/MagicDNS environment.
$MacHost = "mac-user@mac-mini"
$Project = "~/Projects/mac-agent-gateway"
$ArtifactDestination = Join-Path $PSScriptRoot "..\artifacts-macos"

Write-Host "Testing $Project on $MacHost"

ssh $MacHost @"
set -euo pipefail
cd $Project
git status --short
corepack enable
pnpm install --no-frozen-lockfile
pnpm bootstrap:validate
pnpm typecheck
pnpm test
pnpm build
mkdir -p artifacts
pnpm doctor > artifacts/doctor.txt 2>&1 || true
if [ "`$(uname -s)" = "Darwin" ]; then
  bash scripts/mac-smoke.sh > artifacts/mac-smoke.txt 2>&1 || true
fi
"@

if ($LASTEXITCODE -ne 0) { throw "Remote Mac test failed" }

Remove-Item -Recurse -Force $ArtifactDestination -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $ArtifactDestination | Out-Null
scp -r "${MacHost}:${Project}/artifacts/." $ArtifactDestination
Write-Host "Remote Mac test complete. Artifacts: $ArtifactDestination"
