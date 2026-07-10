param(
  [Parameter(Mandatory=$true)]
  [string]$ProjectRoot,

  [Parameter(Mandatory=$true)]
  [int]$Port,

  [string]$RuntimeId = "manual"
)

$Host.UI.RawUI.WindowTitle = "CodexRuntimeHost - $RuntimeId - 127.0.0.1:$Port"
$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $ProjectRoot
codex app-server --listen "ws://127.0.0.1:$Port"
