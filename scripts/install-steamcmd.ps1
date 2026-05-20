param(
  [string]$SteamCmdDir = "$env:LOCALAPPDATA\PZLocalModManager\steamcmd"
)

$ErrorActionPreference = "Stop"
$zipPath = Join-Path $env:TEMP "steamcmd.zip"

New-Item -ItemType Directory -Force -Path $SteamCmdDir | Out-Null
Write-Host "Downloading SteamCMD..."
Invoke-WebRequest -Uri "https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip" -OutFile $zipPath
Write-Host "Extracting SteamCMD to $SteamCmdDir..."
Expand-Archive -Path $zipPath -DestinationPath $SteamCmdDir -Force
Remove-Item $zipPath -Force
Write-Host "SteamCMD installed."
