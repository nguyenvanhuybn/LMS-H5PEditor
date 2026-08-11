[CmdletBinding()]
param(
    [string]$OutputPath
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Join-Path $repoRoot ".runtime\iis-package"
}
if (-not [System.IO.Path]::IsPathRooted($OutputPath)) {
    $OutputPath = Join-Path $repoRoot $OutputPath
}
$OutputPath = [System.IO.Path]::GetFullPath($OutputPath)
$zipPath = "$OutputPath.zip"

if (Test-Path $OutputPath) {
    throw "Output path already exists: $OutputPath. Choose a new -OutputPath to avoid overwriting an existing package."
}

if (Test-Path $zipPath) {
    throw "Package archive already exists: $zipPath. Choose a new -OutputPath to avoid overwriting it."
}

$webOutput = Join-Path $OutputPath "web"
$apiOutput = Join-Path $OutputPath "api"
$engineOutput = Join-Path $OutputPath "engine"
$seedOutput = Join-Path $OutputPath "engine-seed"
$scriptsOutput = Join-Path $OutputPath "scripts"
$iisOutput = Join-Path $OutputPath "iis"

New-Item -ItemType Directory -Path $OutputPath, $webOutput, $apiOutput, $engineOutput, $seedOutput, $scriptsOutput, $iisOutput | Out-Null

Push-Location $repoRoot
try {
    # This value is inlined into the browser bundle. IIS maps /backend to the
    # local ASP.NET service, keeping browser requests same-origin.
    $env:NEXT_PUBLIC_API_URL = "/backend"
    $env:H5P_ENGINE_INTERNAL_URL = "http://127.0.0.1:3001"
    $env:VERCEL = "0"

    npm ci --prefix apps/web
    npm --prefix apps/web run build
    dotnet publish apps/api/H5pLms.Api.csproj -c Release -o $apiOutput

    Copy-Item "apps/web/.next/standalone/*" $webOutput -Recurse -Force
    Copy-Item "apps/web/.next/static" (Join-Path $webOutput ".next/static") -Recurse -Force
    Copy-Item "apps/web/public" (Join-Path $webOutput "public") -Recurse -Force

    Copy-Item "services/h5p-engine/package.json" $engineOutput
    Copy-Item "services/h5p-engine/package-lock.json" $engineOutput
    Copy-Item "services/h5p-engine/src" $engineOutput -Recurse
    Copy-Item "services/h5p-engine/translations" $engineOutput -Recurse
    npm ci --prefix $engineOutput --omit=dev

    # The engine needs these assets in its persistent H5P data directory. They
    # are copied with seed-h5p-data.ps1 on the IIS server before first start.
    Copy-Item "services/h5p-engine/h5p/core" $seedOutput -Recurse
    Copy-Item "services/h5p-engine/h5p/editor" $seedOutput -Recurse

    Copy-Item "deploy/iis/site.web.config" (Join-Path $iisOutput "web.config")
    Copy-Item "deploy/iis/run-api.cmd.template" (Join-Path $scriptsOutput "run-api.cmd")
    Copy-Item "deploy/iis/run-engine.cmd.template" (Join-Path $scriptsOutput "run-engine.cmd")
    Copy-Item "deploy/iis/run-web.cmd.template" (Join-Path $scriptsOutput "run-web.cmd")
    Copy-Item "deploy/iis/seed-h5p-data.ps1" $scriptsOutput
    Copy-Item "deploy/iis/README.md" (Join-Path $OutputPath "README.md")

    Compress-Archive -Path (Join-Path $OutputPath "*") -DestinationPath $zipPath
    Write-Host "IIS package created: $zipPath"
}
finally {
    Pop-Location
}
