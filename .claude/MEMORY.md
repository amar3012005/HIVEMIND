# Claude Memory Log — HIVE-MIND

Running log of decisions, actions, implementations across Claude sessions. Append a dated
entry after each meaningful task. Newest at top within a date. Pair with
`.claude/INSTRUCTIONS.md`.

---

## 2026-07-09

### Singulance production topology and deployment baseline
- Production host: `root@singulancelabs.com` (`46.224.4.164`). Live source checkout is
  `/root/hivemind` and is intentionally dirty; never pull, reset, or build from it.
  Clean build/canary checkout is `/root/hivemind-next` on branch
  `codex/production-hardening-runtime`.
- Production Compose: `/root/hivemind/infra/docker-compose.hetzner.yml`, always invoked
  with `--env-file /root/hivemind/.env`. Core/control are Compose-managed only: never
  `docker run` them. Caddy config is `/root/hivemind/infra/Caddyfile`; after a Caddy edit,
  restart `hm-caddy` (reload alone is not sufficient in this installation).
- Public routing: `core.singulancelabs.com` -> core `:2026`,
  `api.singulancelabs.com` -> control plane `:2027`, and the production-compatible vNext
  frontend is `https://next.singulancelabs.com/hivemind/app` via loopback `:2388`.
  The vNext FE calls the existing production core/control hosts, preserving OAuth callback,
  connector, Cartesia, and BYOD behavior. `next.singulancelabs.com` is in production CORS.
- Temporary B2B/B2C backend canaries remain isolated and must never receive customer traffic.
  Do not create two frontend applications: one frontend with existing callback URLs is the
  deliberate production design.
- The 16 GB server runs many containers and React production builds are CPU/memory slow.
  Do not add k3s/kubernetes on this single host: it does not provide host failover and adds
  overhead. First reduce idle canaries, enforce resource limits, add off-host backups and
  monitoring; consider k3s only for a multi-node deployment with external/shared data.

### Safe Singulance rollout rules
- Build images from `/root/hivemind-next`, tag the new image separately first, retain the
  current image under a timestamped `rollback-<timestamp>` tag, then retag the approved
  image and recreate only the changed Compose service with `--no-deps --force-recreate`.
- Never run `docker compose` against production without `--env-file /root/hivemind/.env`.
  Missing it injects blank secrets and causes control-plane health failures/502s.
- Mandatory cold checks after a core/control/frontend rollout:
  `https://core.singulancelabs.com/health`,
  `https://api.singulancelabs.com/v1/bootstrap`, and the changed frontend route. Confirm
  `hm-control` is `running/healthy` and inspect recent logs. Roll back to the retained image
  tag and recreate through Compose on failure; never use `git reset --hard` on production.
- The frontend submodule is deployed by committing/pushing its branch, then committing the
  parent gitlink update. Verify the exact submodule SHA in `/root/hivemind-next` before build.

### Platform admin console
- Public route: `/hivemind/platform-admin` on `next.singulancelabs.com`. It lists B2B/B2C,
  active/sleeping users and last activity. The route fallback is absolute
  `/hivemind/app/overview`; do not change it to a relative path or it recurses.
- Admin unlock is `POST /admin/api/platform/unlock`. `HIVEMIND_ADMIN_SECRET` is server-only;
  never store, print, commit, or place its value in browser code or Claude memory. Unlock
  creates a 15-minute `Secure`, `HttpOnly`, `SameSite=Strict` signed cookie. It is rate-limited
  to five failed attempts per IP per 15 minutes.
- `GET /admin/api/platform/users` and `GET /admin/api/platform/logs` require that cookie.
  The admin page polls the latter every two seconds. The old public `/api/logs` endpoint was
  intentionally removed; do not restore unauthenticated raw log access.
- Service-worker cache is `hive-shell-v2`; Umami gateway loader was removed. If an old shell
  appears, hard reload/unregister the stale service worker before debugging application code.

## 2026-05-30

### CSI / MiroFish + Employees architecture docs
- Wrote `CSI_MIROFISH.md` (root): prompt->ontology->graph->agents->config->CSI rounds->report
  pipeline + single-round sequence diagram + artifact schema. Source: MiroFish/backend.
- Wrote `DIGITAL_EMPLOYEES_AND_HYPER_AGENTS.md` (root): full functionality + architecture.
  Node control-plane + Python employees-service (FastAPI :8060), shared Postgres,
  AgentScope ReAct, R1-R5 swarm phase machine.

### Architectural finding (HyperAgents vs CSI)
- Crucial gap: HyperAgents has NO persistent, queryable, provenance-linked CLAIM/TRIAL
  artifact graph. Debate lives in `HyperTurn.lines[]` (transcript in one row); only final
  decision saved to memory -> reasoning graph discarded.
- MiroFish CSI = first-class durable artifacts, concurrent agents (ThreadPool 8), evidence-
  grounded confidence recompute, source/web-ingest loop, accumulate + synthesize.
- Recommended (NOT implemented): persistent CSI artifact layer behind HyperAgents + concurrent
  execution. Explicitly WITHOUT token caps/seals (user constraint).

### Maintenance setup
- Created `.claude/INSTRUCTIONS.md` + `.claude/MEMORY.md`. Update MEMORY per task,
  INSTRUCTIONS when rules emerge.

## 2026-05-29

### i18n coverage
- OSS verdict: already best stack (i18next + react-i18next) + runtime Groq auto-translate;
  gap was COVERAGE. Wired `t()` into 34 pages (keyed+default, ns 'dashboard'); skipped 2
  string-less graph renderers. Toggle+RTL already correct (src/i18n.js + LangSwitcher ->
  hivemind:lang). Verified all 41 pages parse + full react-scripts build exit 0. Workflow
  blocked -> ran as 10 parallel Agent batches.

### Chat.jsx redesign
- Restyled slide-in chat panel (glass header, scope pill, gradient bubbles, focus-glow
  composer, suggestion chips wired to existing setInput). Logic/exports preserved. +101 lines.

### Walkthrough cards
- `app/shared/Walkthrough.jsx` + useWalkthrough gating + DEFAULT_STEPS. Wired into AppShell
  (first-run gated). Verified via ui-preview skill.

### Transactional email (Gmail-over-Nango)
- Decision: NOT Gmail MCP (session-bound). Use enterprise Gmail via Nango google-mail send.
  Built core/src/email/{templates.json, email-service.js} (sendSystemEmail, never throws,
  429/5xx retry, HTML-escaped). Route POST /v1/notifications/welcome (session user only,
  once/session). Overview.jsx fires once/session. Pending: connect mailbox + set
  SYSTEM_EMAIL_NANGO_CONNECTION_ID. No-ops until set.

### Global skills
- ~/.claude/skills/ui-preview/ — isolated React screenshots (Tailwind CDN + esm.sh + babel
  + Python Playwright; multiline-import fix; greenlet user-site escape).
- ~/.claude/skills/web-search/ — Tavily via blaiq LiteLLM gateway. Blocked on gateway's
  invalid Tavily provider key (set valid tvly-... in LiteLLM UI). LITELLM_API_KEY in ~/.zshrc.

### SEO/GEO (open)
- Applied JSON-LD (Org sameAs, FAQPage), llms.txt, sitemap, robots AI-bot allows,
  react-helmet per-route meta. react-snap prerender FAILED (Chromium not downloaded) ->
  build green but no prerendered HTML. Decision pending: fix react-snap vs Vercel edge.
