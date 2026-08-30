param(
  [string]$ProductionSshHost = 'singulance',
  [string]$ProductionCoreContainer = 'hm-core',
  [string]$TestOrgId = '47e2ba84-1b9f-4e1b-804b-7bd77d4eea0f',
  [string]$WorkflowUrl = 'https://hivemind-knowledge-ingest-local.amarsai2005.workers.dev',
  [string]$DurableChatUrl = '',
  [string]$DurableChatSecret = ''
)

$ErrorActionPreference = 'Stop'
$repo = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$compose = @('-p', 'hivemind', '-f', (Join-Path $repo 'docker-compose.local-stack.yml'))
$localServices = Join-Path $repo 'docker-compose.local-services.yml'
if (Test-Path -LiteralPath $localServices) { $compose += @('-f', $localServices) }

# These are inference/parser policy variables only. Database, Redis, Qdrant,
# public URLs, auth/session identity, and Cloudflare lifecycle resources remain
# local and are never imported from production.
$allowed = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
@(
  'BLAIQ_EMBED_BASE_URL','BLAIQ_EMBED_MODEL','BLAIQ_EMBED_TIMEOUT_MS',
  'CLOUDFLARE_ACCOUNT_ID','CLOUDFLARE_AI_GATEWAY_BGE_EMBEDDINGS_PROVIDER',
  'CLOUDFLARE_AI_GATEWAY_BGE_RERANKER_PROVIDER','CLOUDFLARE_AI_GATEWAY_BLAIQ_BYOK_ALIAS',
  'CLOUDFLARE_AI_GATEWAY_BLAIQ_PROVIDER','CLOUDFLARE_AI_GATEWAY_CARTESIA_BYOK_ALIAS',
  'CLOUDFLARE_AI_GATEWAY_CEREBRAS_BYOK_ALIAS','CLOUDFLARE_AI_GATEWAY_DEEPGRAM_BYOK_ALIAS',
  'CLOUDFLARE_AI_GATEWAY_ENABLED','CLOUDFLARE_AI_GATEWAY_GROQ_BYOK_ALIAS',
  'CLOUDFLARE_AI_GATEWAY_ID','CLOUDFLARE_AI_GATEWAY_OPENROUTER_BYOK_ALIAS',
  'CLOUDFLARE_AI_GATEWAY_TEXT_ROUTE','CLOUDFLARE_AI_GATEWAY_TOKEN',
  'EMBEDDING_API_KEY','EMBEDDING_DIMENSION','EMBEDDING_FALLBACK_PROVIDER',
  'EMBEDDING_FALLBACK2_PROVIDER','EMBEDDING_MODEL_NAME','EMBEDDING_MODEL_URL',
  'EMBEDDING_PROVIDER','EMBEDDING_TIMEOUT_MS','EMBEDDINGS_SERVICE_URL',
  'GROQ_API_KEY','GROQ_API_TIMEOUT','GROQ_BASE_PROMPT','GROQ_INFERENCE_MODEL',
  'GROQ_LANGUAGE','GROQ_MAX_RETRIES','GROQ_VISION_MODEL','GROQ_WHISPER_MODEL',
  'KB_ALLOW_PER_FACT_LLM_LINKING','KB_CONSOLIDATE','KB_CURATED_MEMORY_CAP',
  'KB_CURATOR_MODEL','KB_DISTILL_WINDOW_CHARS','KB_ENABLE_ALGO_VERSION_EDGES',
  'KB_ENRICH_ENABLED','KB_ENTITY_LINK_MODE','KB_EXTRACT_FORMATS','KB_EXTRACT_TIMEOUT_MS',
  'KB_FACTS_PER_1K_CHARS','KB_INGEST_VERBOSE','KB_MIN_FACTS_PER_WINDOW',
  'KB_SEGMENT_WRITE_ATTEMPTS','KB_UNIFIED_EMPTY_RETRIES','KB_UNIFIED_EXTRACT',
  'KB_UNIFIED_FALLBACK_MODELS','KB_UNIFIED_MODEL','KB_UNIFIED_WINDOW_CHARS',
  'LITELLM_API_KEY','LITELLM_BASE_URL','LITELLM_EMBED_MODEL',
  'LLM_API_KEY','LLM_MODEL','LLM_PRIMARY','LLM_PROVIDER',
  'MEMORY_PROCESSOR_MODEL','MISTRAL_API_KEY','MISTRAL_EMBEDDING_MODEL',
  'OPENROUTER_API_KEY','OPENROUTER_BASE_URL','OPENROUTER_EMBED_MODEL',
  'OPENROUTER_EMBED_TIMEOUT_MS','SINGULANCE_EMBED_API_KEY',
  'SINGULANCE_EMBED_BASE_URL','SINGULANCE_EMBED_MODEL'
) | ForEach-Object { [void]$allowed.Add($_) }

$productionLines = & ssh $ProductionSshHost "docker inspect $ProductionCoreContainer --format '{{range .Config.Env}}{{println .}}{{end}}'"
if ($LASTEXITCODE -ne 0) { throw 'Unable to read the production Core environment over SSH.' }
foreach ($line in $productionLines) {
  $split = $line.IndexOf('=')
  if ($split -lt 1) { continue }
  $name = $line.Substring(0, $split)
  if ($allowed.Contains($name)) {
    [Environment]::SetEnvironmentVariable($name, $line.Substring($split + 1), 'Process')
  }
}

# Preserve existing local-only auth material without ever printing it.
$localApi = (& docker inspect hivemind-api 2>$null | ConvertFrom-Json | ForEach-Object { $_[0].Config.Env })
foreach ($line in $localApi) {
  $split = $line.IndexOf('=')
  if ($split -lt 1) { continue }
  $name = $line.Substring(0, $split)
  if ($name -in @('HIVEMIND_MASTER_API_KEY','HIVEMIND_ADMIN_SECRET','HIVEMIND_OAUTH_SESSION_SECRET','SESSION_SECRET')) {
    [Environment]::SetEnvironmentVariable($name, $line.Substring($split + 1), 'Process')
  }
}

# The control plane runs with NODE_ENV=production even in the isolated preview
# stack, so the well-known development master key is deliberately rejected by
# internal-auth. Generate an ephemeral local-only key when an old stack still
# carries that placeholder, and recreate both Core and the control plane with
# the same value. The key is never printed or imported from production.
$localMasterKey = [Environment]::GetEnvironmentVariable('HIVEMIND_MASTER_API_KEY', 'Process')
if ([string]::IsNullOrWhiteSpace($localMasterKey) -or $localMasterKey -eq 'hm_master_key_99228811') {
  $masterBytes = New-Object byte[] 48
  [Security.Cryptography.RandomNumberGenerator]::Fill($masterBytes)
  $localMasterKey = [Convert]::ToBase64String($masterBytes)
  [Environment]::SetEnvironmentVariable('HIVEMIND_MASTER_API_KEY', $localMasterKey, 'Process')
}
[Environment]::SetEnvironmentVariable('API_MASTER_KEY', $localMasterKey, 'Process')

function New-LocalSecret {
  $bytes = New-Object byte[] 48
  [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  return [Convert]::ToBase64String($bytes)
}

$adminSecret = [Environment]::GetEnvironmentVariable('HIVEMIND_ADMIN_SECRET', 'Process')
if ([string]::IsNullOrWhiteSpace($adminSecret) -or $adminSecret -eq 'local-admin-secret-change-me') {
  [Environment]::SetEnvironmentVariable('HIVEMIND_ADMIN_SECRET', (New-LocalSecret), 'Process')
}

$oauthSecret = [Environment]::GetEnvironmentVariable('HIVEMIND_OAUTH_SESSION_SECRET', 'Process')
if ([string]::IsNullOrWhiteSpace($oauthSecret) -or $oauthSecret -eq 'change-me') {
  $sessionBytes = New-Object byte[] 48
  [Security.Cryptography.RandomNumberGenerator]::Fill($sessionBytes)
  [Environment]::SetEnvironmentVariable('HIVEMIND_OAUTH_SESSION_SECRET', [Convert]::ToBase64String($sessionBytes), 'Process')
}

$controlSessionSecret = [Environment]::GetEnvironmentVariable('SESSION_SECRET', 'Process')
if ([string]::IsNullOrWhiteSpace($controlSessionSecret) -or $controlSessionSecret -eq 'local-session-secret-change-me') {
  [Environment]::SetEnvironmentVariable('SESSION_SECRET', (New-LocalSecret), 'Process')
}

$controlEnv = (& docker inspect hivemind-control-plane-local | ConvertFrom-Json | ForEach-Object { $_[0].Config.Env })
$workflowSecretLine = $controlEnv | Where-Object { $_ -like 'KNOWLEDGE_INGEST_WORKFLOW_SECRET=*' } | Select-Object -First 1
if (-not $workflowSecretLine) { throw 'The local control plane has no Workflow shared secret.' }
$workflowSecret = $workflowSecretLine.Substring('KNOWLEDGE_INGEST_WORKFLOW_SECRET='.Length)
if ([string]::IsNullOrWhiteSpace($workflowSecret)) { throw 'The local Workflow shared secret is empty.' }

[Environment]::SetEnvironmentVariable('HIVEMIND_LOCAL_MODE', 'true', 'Process')
[Environment]::SetEnvironmentVariable('KNOWLEDGE_INGEST_WORKFLOW_ENABLED', 'true', 'Process')
[Environment]::SetEnvironmentVariable('KNOWLEDGE_INGEST_WORKFLOW_URL', $WorkflowUrl, 'Process')
[Environment]::SetEnvironmentVariable('KNOWLEDGE_INGEST_WORKFLOW_SECRET', $workflowSecret, 'Process')
[Environment]::SetEnvironmentVariable('DOCLING_URL', 'http://docling:5001', 'Process')
[Environment]::SetEnvironmentVariable('KB_EXTRACT_URL', 'http://hm-extract:8088', 'Process')
if (-not [string]::IsNullOrWhiteSpace($DurableChatUrl) -and -not [string]::IsNullOrWhiteSpace($DurableChatSecret)) {
  [Environment]::SetEnvironmentVariable('DURABLE_CHAT_AGENT_ENABLED', 'true', 'Process')
  [Environment]::SetEnvironmentVariable('CLOUDFLARE_CHAT_AGENT_URL', $DurableChatUrl, 'Process')
  [Environment]::SetEnvironmentVariable('CLOUDFLARE_CHAT_AGENT_SECRET', $DurableChatSecret, 'Process')
}

$decision = Invoke-RestMethod -Uri "$WorkflowUrl/enabled?org_id=$([Uri]::EscapeDataString($TestOrgId))" `
  -Headers @{ Authorization = "Bearer $workflowSecret" } -TimeoutSec 20
if ($decision.enabled -ne $true) { throw "Flagship knowledge_ingest_workflow_v1 is not enabled for $TestOrgId." }

Push-Location $repo
try {
  & docker compose @compose up -d --no-deps docling hm-extract
  if ($LASTEXITCODE -ne 0) { throw 'Unable to start local parser services.' }
  & docker compose @compose up -d --no-build --no-deps --force-recreate api
  if ($LASTEXITCODE -ne 0) { throw 'Unable to recreate the local API.' }
} finally {
  Pop-Location
}

$healthy = $false
for ($attempt = 0; $attempt -lt 36; $attempt += 1) {
  Start-Sleep -Seconds 5
  try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/health' -TimeoutSec 5
    if ($health.ok -and $health.dependencies.db -and $health.dependencies.qdrant -and $health.phase1.docling_adapter) {
      $healthy = $true
      break
    }
  } catch {}
}
if (-not $healthy) { throw 'The production-parity local API did not become healthy with Docling enabled.' }

# Recreate the proxy after Core is healthy so authenticated browser reads use
# the same non-placeholder internal key and do not collapse into misleading
# 503 responses while both containers themselves appear healthy.
Push-Location $repo
try {
  $services = @(& docker compose @compose config --services)
  if ($services -contains 'control-plane') {
    & docker compose @compose up -d --no-build --no-deps --force-recreate control-plane
    if ($LASTEXITCODE -ne 0) { throw 'Unable to recreate the local control plane.' }
  }
} finally {
  Pop-Location
}

$controlHealthy = $false
for ($attempt = 0; $attempt -lt 24; $attempt += 1) {
  Start-Sleep -Seconds 2
  try {
    $controlHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:3001/health' -TimeoutSec 5
    if ($controlHealth.ok) { $controlHealthy = $true; break }
  } catch {}
}
if (-not $controlHealthy) { throw 'The local control plane did not become healthy.' }

[pscustomobject]@{
  ok = $true
  flagship_enabled = $true
  api_healthy = $true
  control_plane_healthy = $true
  docling_adapter = [bool]$health.phase1.docling_adapter
  embeddings_configured = [bool]$health.amr_engine.embeddingsConfigured
  production_inference_policy = $true
  local_data_plane = $true
  durable_chat_enabled = -not [string]::IsNullOrWhiteSpace($DurableChatUrl)
} | ConvertTo-Json -Compress
