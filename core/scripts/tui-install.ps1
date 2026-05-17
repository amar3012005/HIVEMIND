# HIVEMIND MCP TUI installer shim (Windows). Usage:
#   irm https://<endpoint>/install/tui.ps1 | iex
$ErrorActionPreference = 'Stop'

$Base   = '__HIVEMIND_BASE__'
$ApiKey = if ($env:HIVEMIND_API_KEY) { $env:HIVEMIND_API_KEY } `
          elseif ('__HAS_API_KEY__' -eq '1') { '__API_KEY__' } `
          else { '' }

$BinDir = Join-Path $env:LOCALAPPDATA 'HIVEMIND\bin'
New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
$Dest = Join-Path $BinDir 'hivemind-mcp.exe'

Write-Host "Downloading hivemind-mcp-windows-amd64.exe…" -ForegroundColor Cyan
Invoke-WebRequest -Uri "$Base/install/tui/hivemind-mcp-windows-amd64.exe" -OutFile $Dest -UseBasicParsing
Write-Host "Installed to $Dest" -ForegroundColor Green

if ($ApiKey) { $env:HIVEMIND_API_KEY = $ApiKey }

# Add to user PATH if not present
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$BinDir*") {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$BinDir", 'User')
  $env:Path = "$env:Path;$BinDir"
}

Write-Host "Launching HIVEMIND MCP installer…" -ForegroundColor Cyan
& $Dest
