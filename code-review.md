HIVE-MIND — Production Readiness Review

  Verdict: BLOCK — Do not deploy

  31 CRITICAL + HIGH issues must be resolved before this codebase touches production.

  ---
  CRITICAL Issues (13) — Fix Immediately

  Secrets & Credentials

  ┌─────┬───────────────────────────────────────────────────┬─────────────────────────────────────────────┬──────────┐
  │  #  │                       Issue                       │                    File                     │   Line   │
  ├─────┼───────────────────────────────────────────────────┼─────────────────────────────────────────────┼──────────┤
  │ 1   │ Live Groq + Mistral API keys in committed env     │ .env.test, core/.env                        │ 4, 8     │
  │     │ files                                             │                                             │          │
  ├─────┼───────────────────────────────────────────────────┼─────────────────────────────────────────────┼──────────┤
  │ 2   │ Hardcoded fallback API key                        │ mcp-server/server.js                        │ 47       │
  │     │ dev_api_key_hivemind_2026                         │                                             │          │
  ├─────┼───────────────────────────────────────────────────┼─────────────────────────────────────────────┼──────────┤
  │ 3   │ Weak default admin secret                         │ core/src/server.js                          │ 145      │
  │     │ local-admin-secret-change-me                      │                                             │          │
  ├─────┼───────────────────────────────────────────────────┼─────────────────────────────────────────────┼──────────┤
  │ 4   │ Weak default session secret change-me             │ core/src/control-plane-server.js            │ 50       │
  ├─────┼───────────────────────────────────────────────────┼─────────────────────────────────────────────┼──────────┤
  │ 5   │ Hardcoded HSM master key in SQL init script       │ infra/init-scripts/01-init-hivemind.sql     │ 13       │
  ├─────┼───────────────────────────────────────────────────┼─────────────────────────────────────────────┼──────────┤
  │ 6   │ Hardcoded Qdrant API key in config                │ infra/qdrant/config.yaml                    │ 32       │
  ├─────┼───────────────────────────────────────────────────┼─────────────────────────────────────────────┼──────────┤
  │ 7   │ Hardcoded postgres:postgres creds in 4            │ docker-compose.traefik.yml, simple, ssl,    │ multiple │
  │     │ docker-compose files                              │ caddy                                       │          │
  ├─────┼───────────────────────────────────────────────────┼─────────────────────────────────────────────┼──────────┤
  │ 8   │ NODE_ENV=production with dev credentials          │ core/.env                                   │ 9        │
  └─────┴───────────────────────────────────────────────────┴─────────────────────────────────────────────┴──────────┘

  Security Architecture

  ┌─────┬──────────────────────────────────────────────────────┬─────────────────────────────────────┬───────────┐
  │  #  │                        Issue                         │                File                 │   Line    │
  ├─────┼──────────────────────────────────────────────────────┼─────────────────────────────────────┼───────────┤
  │ 9   │ Wildcard CORS (*) on all endpoints including admin   │ core/src/server.js                  │ 677-679   │
  ├─────┼──────────────────────────────────────────────────────┼─────────────────────────────────────┼───────────┤
  │ 10  │ Unbounded request body — trivial OOM DoS             │ core/src/server.js                  │ 2281-2293 │
  ├─────┼──────────────────────────────────────────────────────┼─────────────────────────────────────┼───────────┤
  │ 11  │ Admin secret compared with === (timing oracle)       │ core/src/server.js                  │ 614-616   │
  ├─────┼──────────────────────────────────────────────────────┼─────────────────────────────────────┼───────────┤
  │ 12  │ Traefik dashboard --api.insecure=true on live domain │ docker-compose.traefik.yml          │ 7         │
  ├─────┼──────────────────────────────────────────────────────┼─────────────────────────────────────┼───────────┤
  │ 13  │ Prometheus admin API exposed without auth            │ infra/docker-compose.production.yml │ 381       │
  └─────┴──────────────────────────────────────────────────────┴─────────────────────────────────────┴───────────┘

  ---
  HIGH Issues (18) — Fix Before Merge

  Data Integrity & Auth

  - DELETE /api/memories/:id has no ownership check — any user can delete any memory (server.js:1054)
  - Path traversal via unsanitized memoryId — user input goes directly into data layer (server.js:1035)
  - Path traversal via evaluationId in file paths (server.js:533-535)
  - memoryId not validated before URL interpolation in MCP server (mcp-server/server.js:785)
  - SSRF via sendWebhook — arbitrary URLs in fetch() (hmac-handler.js:335)
  - Open redirect via return_to parameter (control-plane-server.js:267)
  - K8s RBAC allows reading ALL secrets namespace-wide (k8s/namespace.yaml:125)

  Reliability & Performance

  - No rate limiting on any endpoint — config vars defined but never implemented (server.js)
  - Floating promise in sessionEndHook — all auto-captured session memories silently dropped (engine.local.js:559)
  - Race condition on API key file store — concurrent reads/writes corrupt data (server.js:516-525)
  - Unbounded aggregateCache Map — grows until OOM under unique queries (server.js:158)
  - Unbounded embedding cache — no size limit or TTL (groq.js:87)
  - No timeouts on fetch() calls — hangs indefinitely if backend is down (mcp-server/server.js:1047,
  control-plane-server.js:205)
  - relationships array grows unbounded — memory leak in long-lived processes (engine.local.js:29)

  Infrastructure

  - All security hardening commented out in production Coolify compose (docker-compose.coolify.yml:14-17)
  - Source code bind-mounted into production container — bypasses CI/CD (docker-compose.production.yml:181)
  - PostgreSQL SSL disabled everywhere — cleartext DB traffic (postgresql.conf:19)
  - LUKS2 master key stored as plaintext file on disk (luks2-setup.sh:30)

  ---
  MEDIUM Issues (15)

  - Error messages leak internal details (stack traces, table names) to clients
  - Duplicate storeMemory method — async version is dead code, sync version runs (engine.local.js:211 vs 858)
  - Weak djb2 hash for embedding cache keys — collision risk (groq.js:363)
  - require('express') in ES module — will throw ReferenceError at runtime (router.js:365)
  - World-readable MCP log file in /tmp (safe-logger.js:4)
  - Session cookie missing Secure flag (control-plane-server.js:121)
  - No HTTP security headers (CSP, HSTS, X-Frame-Options) on HTML endpoints
  - Non-UUID user/org IDs in key store weaken tenant isolation
  - X-Admin-Secret advertised in CORS headers
  - Vault UI exposed publicly (vault-config.hcl:66)
  - Grafana default admin password admin (docker-compose.sovereign.yml:252)
  - Docker volumes not bound to encrypted paths in sovereign compose
  - K8s Secret manifests contain unresolved ${VAR} template strings
  - Backup containers have no resource limits
  - Zero test coverage for auth flows, webhook HMAC, and control plane

  ---
  Top 5 Actions Before Any Deployment

  1. Rotate all leaked keys now — Groq (gsk_Zu4B...), Mistral (k2jqL...), and any Postgres passwords that matched the
  hardcoded defaults
  2. Remove all hardcoded fallback secrets — fail fast at startup if env vars are missing
  3. Add request body size limits and rate limiting — the server is trivially DoS-able today
  4. Fix CORS — replace * with an explicit origin allowlist, remove X-Admin-Secret from allowed headers
  5. Add ownership checks on DELETE and validate all IDs (UUID format) before use