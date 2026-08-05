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
Test-Command tailscale $false | Out-Null
Test-Command ssh $false | Out-Null

if (-not (Test-Path .env)) {
    Copy-Item .env.example .env
    Write-Host "Created .env from .env.example"
}

if (-not $ok) {
    throw "Install required tools before continuing. Node.js 24 LTS is recommended."
}

corepack enable
Write-Host "Next: pnpm install; pnpm bootstrap:validate; pnpm doctor; pnpm test"
