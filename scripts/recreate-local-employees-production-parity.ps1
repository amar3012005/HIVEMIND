[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$allowed = @(
    "GROQ_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENROUTER_API_KEY",
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_AI_GATEWAY_ENABLED",
    "CLOUDFLARE_AI_GATEWAY_ID",
    "CLOUDFLARE_AI_GATEWAY_TOKEN",
    "CLOUDFLARE_AI_GATEWAY_BASE_URL",
    "CLOUDFLARE_AI_GATEWAY_OPENROUTER_BYOK_ALIAS"
)

Push-Location $repoRoot
try {
    $remoteEnvironment = ssh singulance `
        "docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' hm-employees"
    if ($LASTEXITCODE -ne 0) {
        throw "Could not read the governed Employees provider configuration."
    }

    $loaded = 0
    foreach ($line in $remoteEnvironment) {
        $parts = $line -split "=", 2
        if ($parts.Count -eq 2 -and $allowed -contains $parts[0]) {
            [Environment]::SetEnvironmentVariable($parts[0], $parts[1], "Process")
            $loaded += 1
        }
    }
    if ($loaded -lt 5) {
        throw "The governed provider configuration is incomplete ($loaded fields loaded)."
    }

    docker compose -p hivemind --env-file .env.grok-local `
        -f docker-compose.local-stack.yml `
        -f docker-compose.local-services.yml `
        up -d --no-deps --force-recreate employees
    if ($LASTEXITCODE -ne 0) {
        throw "Employees recreation failed."
    }

    Start-Sleep -Seconds 8
    $health = Invoke-WebRequest -UseBasicParsing `
        -Uri "http://localhost:8060/health" -TimeoutSec 15
    if ($health.StatusCode -ne 200) {
        throw "Employees health check returned $($health.StatusCode)."
    }
    Write-Output "Employees recreated with governed provider parity; health=200."
}
finally {
    foreach ($name in $allowed) {
        [Environment]::SetEnvironmentVariable($name, $null, "Process")
    }
    Pop-Location
}
