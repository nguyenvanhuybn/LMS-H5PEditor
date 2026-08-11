[CmdletBinding()]
param(
    [string]$DataPath = "C:\H5P\data\h5p"
)

$ErrorActionPreference = "Stop"
$seedPath = Join-Path $PSScriptRoot "..\engine-seed"

New-Item -ItemType Directory -Force -Path $DataPath, (Join-Path $DataPath "content"), (Join-Path $DataPath "libraries"), (Join-Path $DataPath "temp") | Out-Null

foreach ($asset in @("core", "editor")) {
    $destination = Join-Path $DataPath $asset
    if (-not (Test-Path $destination)) {
        Copy-Item (Join-Path $seedPath $asset) $destination -Recurse
    }
}

Write-Host "H5P data initialized at $DataPath"
