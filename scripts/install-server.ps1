param(
  [string]$SteamCmdDir = "$env:LOCALAPPDATA\PZLocalModManager\steamcmd",
  [string]$ServerDir = "$env:LOCALAPPDATA\PZLocalModManager\pz-dedicated",
  [string]$BetaBranch = "unstable"
)

$ErrorActionPreference = "Stop"
$steamCmd = Join-Path $SteamCmdDir "steamcmd.exe"
if (!(Test-Path $steamCmd)) {
  throw "steamcmd.exe not found at $steamCmd. Install SteamCMD first."
}

New-Item -ItemType Directory -Force -Path $ServerDir | Out-Null
$args = @("+force_install_dir", $ServerDir, "+login", "anonymous", "+app_update", "380870")
if ($BetaBranch -and $BetaBranch.Trim().Length -gt 0) {
  $args += @("-beta", $BetaBranch)
}
$args += @("validate", "+quit")

Write-Host "Installing/updating Project Zomboid Dedicated Server app 380870..."
Write-Host "$steamCmd $($args -join ' ')"
& $steamCmd @args
if ($LASTEXITCODE -ne 0) {
  throw "SteamCMD exited with code $LASTEXITCODE"
}
Write-Host "Server install/update complete."
