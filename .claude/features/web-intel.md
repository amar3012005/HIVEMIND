# Web Intel, MCP, And API Keys

## Production Gate Evidence

Completed on 2026-08-03 from merged release SHA `a936b2694336ca07375a0a0862c93ab2493adbf6`.

- Web jobs and exactly-once usage settlements are durable in `hivemind.web_intel_jobs` and `hivemind.web_intel_usage_settlements`.
- Failed and queued jobs do not consume customer allowance; only a successful durable settlement is billable.
- Web provider routing is Tavily then Firecrawl then Lightpanda for search, and Firecrawl then Lightpanda then direct fetch for crawl.
- MCP exposes each web capability only when the API key has the corresponding explicit allow-list scope, including `web_research`.
- API keys support explicit personal and organization-service kinds; service keys do not inherit unrestricted personal-memory access.
- The database migration `20260802170000_web_intel_durable_jobs` was applied directly and verified. Do not run `prisma migrate deploy` against production.
- Targeted validation passed: Prisma schema validation, syntax checks for the Core and Control Plane entry points, and 20 Web/MCP tests.
- Frontend production build passed after the `FileText` import correction in frontend commit `732bcad`.
- Control Plane deployed as `hivemind/control-plane:prod-20260803-a936b2694336`, with a retained `stable` image. Public Control Plane, Core, and login endpoints returned HTTP 200.

## Release Boundaries

- `/root/hivemind-main` and clean worktrees are build/review/commit sources.
- `/root/hivemind` is Compose/run only.
- TARA, Deepgram, `/voice2`, Campaign Intelligence, and HQ Runtime were not changed by this feature gate.
