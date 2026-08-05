$ErrorActionPreference = "Stop"

Write-Host "Mac Agent Windows development check"

function Test-Command([string]$Name, [bool]$Required = $true) {
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if ($cmd) {
        Write-Host "✓ $Name"
        return $true
    }
    $suffix = if ($Required) { "required" } else { "optional" }
    Write-Host "✗ $Name missing ($suffix)"
    return -not $Required
}

$ok = $true
$ok = (Test-Command node) -and $ok
$ok = (Test-Command git) -and $ok
$ok = (Test-Command corepack) -and $ok
Test-Command ssh $false | Out-Null

if (-not (Test-Path .env)) {
    Copy-Item .env.example .env
    Write-Host "Created .env from .env.example"
}

if (-not $ok) {
    throw "Install required tools before continuing. Node.js 22 or newer is required."
}

# Do not run `corepack enable` here. With MSI-installed Node.js it may try to
# create package-manager shims under C:\Program Files\nodejs and fail without
# elevation. Calling Corepack explicitly uses the pnpm version pinned by
# package.json without modifying the system installation.
& corepack pnpm --version
if ($LASTEXITCODE -ne 0) {
    throw "Corepack could not start the project's pnpm version."
}

Write-Host "✓ project pnpm is available through Corepack"
Write-Host "Next commands:"
Write-Host "  corepack pnpm install"
Write-Host "  corepack pnpm bootstrap:validate"
Write-Host "  corepack pnpm doctor"
Write-Host "  corepack pnpm test"
Write-Host "  corepack pnpm dev"
