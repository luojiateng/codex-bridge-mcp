param(
  [string]$ServerName = "codex_bridge",
  [string]$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
)

$distIndex = Join-Path $ProjectRoot "dist\index.js"

Write-Host "Codex Bridge MCP install snippet"
Write-Host ""
Write-Host "[mcp_servers.$ServerName]"
Write-Host 'command = "node"'
Write-Host "args = [`"$distIndex`"]"
Write-Host "startup_timeout_sec = 20"
Write-Host "tool_timeout_sec = 600"
Write-Host ""
Write-Host "Add this snippet to a trusted Codex/Claude MCP config after running npm install and npm run build."
