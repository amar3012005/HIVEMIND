param(
  [string]$StatePath = 'P:\hivemind-wrangler-state\knowledge-ingest',
  [int]$Port = 8788
)

$ErrorActionPreference = 'Stop'
$workerPath = Join-Path $PSScriptRoot '..\workers\knowledge-ingest-lifecycle'
$resolvedWorkerPath = [System.IO.Path]::GetFullPath($workerPath)

if (-not $env:KNOWLEDGE_INGEST_WORKFLOW_SECRET) {
  throw 'Set KNOWLEDGE_INGEST_WORKFLOW_SECRET to a local-only shared secret before starting the Worker.'
}

$stateRoot = [System.IO.Path]::GetFullPath($StatePath)
if (-not $stateRoot.StartsWith('P:\', [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Wrangler state must remain on P:. Received: $stateRoot"
}

New-Item -ItemType Directory -Force -Path $stateRoot | Out-Null
Push-Location $resolvedWorkerPath
try {
  & npm.cmd exec -- wrangler dev --env local --ip 0.0.0.0 --port $Port --persist-to $stateRoot
  if ($LASTEXITCODE -ne 0) { throw "Wrangler exited with code $LASTEXITCODE" }
} finally {
  Pop-Location
}
