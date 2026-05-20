param(
  [string]$Version = "dev"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root "dist"
$stage = Join-Path $dist "PZLocalModManager-$Version"
$zip = Join-Path $dist "PZLocalModManager-$Version.zip"

Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $stage | Out-Null

$include = @("server.js", "package.json", "package-lock.json", "README.md", "start-manager.bat", "public", "scripts", "config", "docs", "data")
foreach ($item in $include) {
  $src = Join-Path $root $item
  if (Test-Path $src) {
    Copy-Item $src (Join-Path $stage $item) -Recurse -Force
  }
}

Remove-Item (Join-Path $stage "node_modules") -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $stage "data\change-log.jsonl") -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $stage "data\workshop-cache.sqlite*") -Force -ErrorAction SilentlyContinue

Remove-Item $zip -Force -ErrorAction SilentlyContinue
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip -Force
Write-Host "Release zip created: $zip"
