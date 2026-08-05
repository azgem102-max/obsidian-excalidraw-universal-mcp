param(
  [string]$Vault,

  [string]$Clients = "all",

  [string]$Font,

  [string]$ProjectRoot
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$installer = Join-Path $repoRoot "install.mjs"
if (-not $ProjectRoot) {
  $ProjectRoot = $repoRoot
}

function Find-NodeCommand {
  $command = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  $candidates = @(
    (Join-Path $env:ProgramFiles "nodejs\node.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "nodejs\node.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\nodejs\node.exe")
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) {
      return $candidate
    }
  }

  throw "Node.js 18 or newer is required. Run setup-windows.cmd to install it automatically."
}

function Select-ObsidianVault {
  Add-Type -AssemblyName System.Windows.Forms
  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
  $dialog.Description = "Select your Obsidian vault"
  $dialog.ShowNewFolderButton = $false

  while ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    $selected = $dialog.SelectedPath
    if (Test-Path -LiteralPath (Join-Path $selected ".obsidian")) {
      return $selected
    }
    [System.Windows.Forms.MessageBox]::Show(
      "This folder is not an Obsidian vault. Open the vault in Obsidian once, then select it again.",
      "Obsidian vault not found",
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Warning
    ) | Out-Null
  }

  throw "Setup was cancelled before an Obsidian vault was selected."
}

if (-not $Vault) {
  $Vault = Select-ObsidianVault
}

if (-not (Test-Path -LiteralPath (Join-Path $Vault ".obsidian"))) {
  throw "The selected folder is not an Obsidian vault. Open it in Obsidian once and try again."
}

$nodeCommand = Find-NodeCommand
$nodeVersion = & $nodeCommand -p "process.versions.node"
$nodeMajor = [int]($nodeVersion.Split(".")[0])
if ($nodeMajor -lt 18) {
  throw "Node.js 18 or newer is required. Installed version: $nodeVersion"
}

$installerArgs = @(
  $installer,
  "--vault", $Vault,
  "--clients", $Clients,
  "--project-root", $ProjectRoot,
  "--node", $nodeCommand
)

if ($Font) {
  $installerArgs += @("--font", $Font)
}

& $nodeCommand @installerArgs
if ($LASTEXITCODE -ne 0) {
  throw "Installer failed. Review the message above."
}

Write-Host ""
Write-Host "Setup completed successfully."
Write-Host "1. Restart Obsidian and open any Excalidraw drawing once."
Write-Host "2. Restart Claude or Codex once."
Write-Host "3. Claude Desktop only: enable the excalidraw connector."
