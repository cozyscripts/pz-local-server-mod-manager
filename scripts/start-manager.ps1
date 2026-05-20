$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$port = if ($env:PORT) { $env:PORT } else { "8787" }

Set-Location $root

if (!(Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host ""
  Write-Host "Node.js 18+ is required to run PZ Local Server Mod Manager." -ForegroundColor Yellow
  Write-Host "Download the Windows LTS installer from https://nodejs.org/"
  Write-Host ""
  Read-Host "Press Enter to close"
  exit 1
}

$versionText = (& node -v).TrimStart("v")
$major = [int]($versionText.Split(".")[0])
if ($major -lt 18) {
  Write-Host "Node.js 18+ is required. Installed version: $versionText" -ForegroundColor Yellow
  Write-Host "Download the Windows LTS installer from https://nodejs.org/"
  Read-Host "Press Enter to close"
  exit 1
}

if (!(Test-Path "node_modules")) {
  Write-Host "Installing app dependencies..."
  npm install
}

Start-Process "http://localhost:$port"
npm start
