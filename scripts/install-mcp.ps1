param(
  [string]$ServerName = "codex_bridge",
  [string]$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
)

$distIndex = Join-Path $ProjectRoot "dist\index.js"
$tomlDistIndex = $distIndex.Replace('\', '\\')
$tomlProjectRoot = $ProjectRoot.Replace('\', '\\')

Write-Host "Codex Bridge MCP stdio setup"
Write-Host ""
Write-Host "[mcp_servers.$ServerName]"
Write-Host 'command = "node"'
Write-Host "args = [`"$tomlDistIndex`"]"
Write-Host "cwd = `"$tomlProjectRoot`""
Write-Host "startup_timeout_sec = 20"
Write-Host "tool_timeout_sec = 600"
Write-Host ""
Write-Host "Use the same node/dist/index.js stdio command in Claude Code."
Write-Host "The stdio adapter starts or reuses one shared local Bridge Core automatically."
Write-Host "No bearer token or separately managed Core terminal is required for stdio clients."
