# Hermes Agents v2 — per-tenant single agent + quick-run library

**Date:** 2026-06-07 · **Status:** approved, executing via phased workflows
**Builds on:** 6e (control-routes, hermes_agents/jobs), 6h (in-container mgmt transport, scoped MCP tokens). Live in prod.

## Goal
Turn the flat "roster of cards" Hermes Agents page into: (1) ONE agent per tenant with its own sub-dashboard (left-nav shell, like HyperAgents rooms), exposing only non-technical enterprise features; (2) a quick-run **library** of curated general-purpose agents runnable in one go (ephemeral, no persistent change). Hide all Hermes complexity (models, keys, raw config, plugins, logs).

## A. Information architecture
- `/hivemind/app/hermes` → two-pane shell: left rail (the agent + nav sections + Library entry), right pane (active section).
- **Singleton via UI**: 6e API supports N agents/org; UI uses ONE canonical agent per org, auto-created idempotently on first visit (`ensureProfile`). No backend schema change — one active `hermes_agents` row is the canonical agent.
- Fixed safe default model (Groq `openai/gpt-oss-20b`), never shown.

## B. Single-agent sub-dashboard (8 sections)
- **Home** — status pill, one-line capability summary, recent activity (runs/approvals).
- **Tasks** (core) — plain-English task → run → live result; past-runs list.
- **Persona** — friendly form (name, role, behavior) → writes profile SOUL.md, restarts gateway. Hide markdown.
- **Schedules** — human→cron builder ("every weekday 9am → X") → Hermes cron per profile.
- **Skills** — capability toggle cards (web search, Slack post, memory R/W). On/off only.
- **Channels** — connect Slack/Telegram/Discord (non-technical) so the agent can act there.
- **Approvals** — queue of actions awaiting human yes/no (6e API).
- **Memory** — read-only HiveMind memories the agent can see.

## C. Quick-run library (Surface 2)
- ~5 curated templates: Research Brief, Summarize a Doc, Competitor Watch, Draft a Reply, Data Q&A. Each = `{id, name, blurb, persona, suggestedTask, skills}` shipped as static config.
- "Run" = ephemeral `runTask(tenant, templateConfig, payload)` on the tenant's profile — no persistent change. Result inline + logged to runs.
- No external/git installs in v1.

## D. Backend (reuse 6e/6h; additive)
- Reuse: `runTask`, `ensureProfile`, scoped MCP keys, control-routes auth + org-scope, mgmt transport.
- New routes in `core/src/hermes/control-routes.js` (flag-gated, session-auth, org-scoped):
  - `GET /hermes/agent` — resolve-or-create the org's canonical agent (singleton).
  - `PUT /hermes/agent/persona` — update name/role/behavior → SOUL + restart.
  - `GET/PUT /hermes/agent/skills` — capability toggles.
  - `GET /hermes/agent/channels`, `POST /hermes/agent/channels/:type/connect` — comms.
  - `GET/POST/DELETE /hermes/agent/schedules` — cron CRUD.
  - `GET /hermes/agent/memory` — proxy HiveMind recall (read-only).
  - `GET /hermes/library`, `POST /hermes/library/:id/run` — templates + ephemeral run.
- mgmt-server (6h) gains writes for SOUL/skills(config.yaml)/cron as needed (same s6 in-container server; no new transport).

## E. Blockers (from live screenshots)
1. **`/hermes/agents/:id/run` → 502** (LIVE): Tasks loop currently broken. Root-cause FIRST (gateway-not-ready vs Groq `reasoning_content` multi-turn 400 vs model mismatch). Prereq of P1.
2. **Cron `402 OpenRouter`**: created in Hermes' OWN dashboard with OpenRouter (out of credits) — separate user experiment, not our flow (we use Groq). The new Schedules tab keeps users out of the raw Hermes cron. Document only.

## F. Phasing (each = its own sequential workflow, verified + deployed before next)
- **P1** — root-cause+fix 502; two-pane shell + left nav; Home; Tasks; Library (curated + ephemeral run). The demo-able core.
- **P2** — Persona; Schedules; Skills.
- **P3** — Channels; Approvals; Memory.

## Constraints / non-negotiables
- NEVER edit `core/src/server.js` (use `control-plane-server.js`). Author `amarsai3012005`.
- Prod has TWO control-planes sharing `/opt/HIVEMIND/core` bind mount: `hm-control` (:3002 deploy.sh) and `control-plane-s0k0…` (Coolify, PUBLIC via caddy-api:8040, `hivemind-control-plane` alias). Code deploys to the bind path reach both; the PUBLIC one reads flags from `/app/.env` (dotenv, set-if-unset) + Coolify env. Restart the Coolify CP for env; both for code.
- FE = Da-vinci repo (`main` → Vercel `davinciai-eu`). Lint clean before push.
- No models/keys/raw config in the UI. Default-OFF flag respected (`HERMES_MANAGER_ENABLED`).
- Verify each phase (node --check + route tests + live e2e) and deploy default-safe before the next.
