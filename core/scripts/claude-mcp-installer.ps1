$Endpoint = '__DIRECT_MCP_ENDPOINT__'
$ApiKey = if ($env:HIVEMIND_API_KEY) { $env:HIVEMIND_API_KEY } elseif ('__HAS_API_KEY__' -eq '1') { '__API_KEY__' } else { '' }

function Write-Section($text) {
  Write-Host ""
  Write-Host $text -ForegroundColor Cyan
}

function Prompt-YesNo($prompt) {
  while ($true) {
    $answer = Read-Host "$prompt [y/n]"
    if ($answer -match '^(?i:y|yes)$') { return $true }
    if ($answer -match '^(?i:n|no)$') { return $false }
    Write-Host 'Please enter y or n.' -ForegroundColor Yellow
  }
}

Clear-Host
Write-Host 'HIVEMIND Claude MCP Installer' -ForegroundColor Cyan
Write-Host 'Installs Claude if needed, configures HIVEMIND MCP, and helps restart Claude.' -ForegroundColor DarkCyan

if (-not $ApiKey) {
  $ApiKey = Read-Host 'Paste your HIVEMIND API key'
}
if (-not $ApiKey) {
  Write-Host 'API key is required.' -ForegroundColor Red
  exit 1
}

$claude = Get-Command claude -ErrorAction SilentlyContinue
if (-not $claude) {
  Write-Section 'Installing Claude...'
  irm https://claude.ai/install.ps1 | iex
  $claude = Get-Command claude -ErrorAction SilentlyContinue
}
if (-not $claude) {
  Write-Host 'Claude is still not available on PATH. Open a new PowerShell window and rerun the installer.' -ForegroundColor Red
  exit 1
}

Write-Section 'Configuring HIVEMIND MCP...'
try { claude mcp remove hivemind | Out-Null } catch {}
claude mcp add --scope user --transport http hivemind $Endpoint --header "Authorization: Bearer $ApiKey"
Write-Host 'HIVEMIND MCP server configured.' -ForegroundColor Green

if (Prompt-YesNo 'Do you want to restart Claude now?') {
  Write-Host 'Please fully quit Claude, then open it again now.' -ForegroundColor Yellow
}

Write-Section 'Next steps'
Write-Host '1. Return to the HIVEMIND Connectors popup.' -ForegroundColor Cyan
Write-Host '2. Click Verify Connection.' -ForegroundColor Cyan
Write-Host '3. If Verify fails, reopen Claude once more and retry.' -ForegroundColor Cyan
Write-Host '4. Continue to the MCP Server prompt page.' -ForegroundColor Cyan
