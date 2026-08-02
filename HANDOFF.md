# Web Intel Production Upgrade Handoff

## Completed

- Created clean worktree `/root/builds/web-intel-production-20260802` from
  `origin/singulance-main` at `dcd5fccd1` on branch
  `codex/web-intel-production-20260802`.
- Recon confirmed existing Web Studio URL modes, existing Web/MCP/API-key
  surfaces, and the production gaps: file-backed `WebJobStore`, per-user job
  quota separate from organization usage, incomplete crawl settlement, Firecrawl
  only in onboarding, static MCP web descriptors, and broad API-key defaults.
- Added and committed `97b387aa2 feat(web): define canonical capability descriptors`.
- Verified descriptor contract:
  `docker run --rm -v "$PWD/core:/src" -w /src node:20-slim node --input-type=module -e "import {getWebCapability,listWebCapabilities} from './src/web/capabilities.js'; if (getWebCapability('crawl').providerOrder[0] !== 'firecrawl' || listWebCapabilities().length !== 3) process.exit(1); console.log('web capability contract ok')"`
  Output: `web capability contract ok`.

## Current Step

Replace the implementation behind `core/src/web/web-job-store.js` with a durable
Prisma-backed adapter while retaining its existing method contract for current
`core/src/server.js` callers.

## Decisions

- Preserve existing public endpoints and `WebStudio`; make them compatibility
  adapters over one upgraded service.
- Provider order: search Tavily -> Firecrawl -> Lightpanda; research Tavily
  Research -> Tavily/Firecrawl evidence fallback; crawl Firecrawl -> Lightpanda
  -> fetch.
- API-key model: personal developer keys plus owner/admin organization service
  keys, both explicitly scoped.
- All organization members may see aggregate provider health and cost telemetry;
  never credentials or cross-tenant payloads.

## Unmet Acceptance Criteria

- Durable web jobs and idempotent organization/user/provider usage ledger.
- Canonical execution service wired into Web Studio, HyperAgents, MCP, and API.
- Firecrawl runtime adapter and provider receipts/fallbacks.
- MCP descriptor generation, API-key scope/service-key hardening, frontend polish.
- Security, integration, browser, release, and production canaries.

## Next Action

Implement the Prisma web job and web usage-event models plus a compatible durable store, then migrate server construction to inject Prisma after initialization.
