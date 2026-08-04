param(
  [Parameter(Mandatory = $true)]
  [string]$Vault,

  [string]$Clients = "all",

  [string]$Font
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$installer = Join-Path $repoRoot "install.mjs"
$nodeCommand = Get-Command node.exe -ErrorAction Stop

$installerArgs = @(
  $installer,
  "--vault", $Vault,
  "--clients", $Clients,
  "--project-root", $repoRoot
)

if ($Font) {
  $installerArgs += @("--font", $Font)
}

& $nodeCommand.Source @installerArgs
if ($LASTEXITCODE -ne 0) {
  throw "Installer failed. Review the message above."
}
