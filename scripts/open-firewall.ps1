param(
  [int]$DefaultPort = 16261,
  [int]$UdpPort = 16262,
  [int]$SteamPort1 = 8766,
  [int]$SteamPort2 = 8767
)

$ErrorActionPreference = "Stop"
$ports = @($DefaultPort, $UdpPort, $SteamPort1, $SteamPort2) | Sort-Object -Unique

foreach ($port in $ports) {
  $name = "Project Zomboid UDP $port"
  if (!(Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName $name -Direction Inbound -Protocol UDP -LocalPort $port -Action Allow | Out-Null
    Write-Host "Opened UDP $port"
  } else {
    Write-Host "Rule already exists for UDP $port"
  }
}
