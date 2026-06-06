# Hermes Runtime Integration — Task Contract

> **Vision:** Give every HiveMind tenant an autonomous "external agent brain" powered by
> [Hermes](https://hermes-agent.nousresearch.com) (NousResearch), controlled exclusively by
> `hm-control`, with **HiveMind MCP as the single system of record for memory**. Hermes keeps
> only operational state (skills, sessions, browser cookies); all recall/save goes through our MCP.

This README is the contract the autonomous cron reads every run. Keep it + `STATE.md` current.

---

## Acceptance criteria (testable "done")

1. A documented, validated **Hermes Agent JSON config** object exists in hm-core (schema + sample + validator).
2. A **`hm-hermes` Docker image** builds and runs: Hermes gateway up on `:8642` (OpenAI-compatible API), dashboard on `:9119`, state persisted to a volume.
3. The Hermes profile has **HiveMind MCP registered** (`mcp.json`) so recall/search/save route to our MCP by default.
4. **hm-control → Hermes service client** works: `runOnce(agent_id, payload)` starts a job; status + logs are pollable/streamable back.
5. **One "Competitor Watcher" agent** runs end-to-end, manual trigger only:
   `FE → hm-control → Hermes → browser/search → HiveMind MCP → result saved + shown in UI`.
6. No multi-tenant pods until the single-container loop is solid (explicit gate).

---

## Recon findings (RULE 0 — finish-first)

- **Greenfield.** `grep -ri hermes` over `core/ services/ employees-service/ docs/` → **no existing Hermes work**. Nothing to finish; build clean (no dead/duplicate path to consolidate).
- **Control plane:** `core/src/control-plane-server.js` (~6793 lines) is `hm-control` — the only thing FE talks to; it must own Hermes lifecycle. New Hermes client lives here (or a sibling module it imports), never called directly by FE.
- **No `hm-hermes`** service in any `docker-compose*.yml` yet.
- **Memory SoR:** HiveMind MCP server already exists (the MCP the IDE/agents use). Hermes registers it in `mcp.json`; do NOT let Hermes use its own local `memories/` as source of truth.
- **Deploy reality (HIVEMIND):** prod runs working-tree **DRIFT** → never `git pull` on server. Deploy = surgical `git checkout origin/<branch> -- <file>` (or scp) + restart, with backup + rollback. Verify with `core/scripts/cold-tests/run-all.mjs`; deploy via `core/scripts/cold-tests/deploy-verified.sh`. Commit author MUST be `amarsai3012005 <amarsai3012005@users.noreply.github.com>`. Never edit `core/src/server.js` blindly (prod drift clobber).

---

## Hermes reference (from official docs, 2026-06)

**Profile** = one isolated Hermes home dir `~/.hermes/profiles/<name>/`:
`config.yaml` (model/provider/toolsets/gateway), `.env` (keys/tokens), `SOUL.md` (persona/system prompt),
`mcp.json` (MCP servers), `memories/`, `sessions/`, `skills/`, `cron/`, `state.db`. Isolated state, NOT a sandbox (same FS access as the user).
- Create: `hermes profile create <name> [--description "..."]`; clone `--clone|--clone-all|--clone-from`.
- Target: `hermes -p <name> <cmd>` / `hermes profile use <name>`. Manage: `list|show|rename|export|import|delete`.
- Each profile gets an alias `~/.local/bin/<name>` and its own gateway + bot token (token locks prevent conflicts).

**Profile distribution** = a profile packaged as a **git repo** (the shareable agent template):
`distribution.yaml` (name, version, `hermes_requires`, `env_requires[]`), `SOUL.md`, `config.yaml`, `mcp.json`, `skills/`, `cron/`, `README.md`.
- **Hard-excluded from distribution:** `.env`, `auth.json`, `memories/`, `sessions/`, `state.db*`, `logs/`, `workspace/`, `local/` (secrets + conversation data never shipped).
- Install: `hermes profile install github.com/you/<repo> [--alias|--name X|-y]`; `update`, `info`, `delete`. No registry — plain git (private repos work via SSH/creds). Distribution-owned files replaced on update; `config.yaml` preserved unless `--force-config`; user-owned (`memories/`/`.env`) never touched.
- → **This is how we ship "Competitor Watcher" / "Form Filler" / "Inbox" agent templates**: one git repo per template, versioned.

**Docker** (`nousresearch/hermes-agent:latest`):
- State volume `/opt/data` (= `~/.hermes`). Ports **8642** (gateway, OpenAI-compatible API), **9119** (dashboard).
- Run gateway: `docker run -d --name hermes --restart unless-stopped -v ~/.hermes:/opt/data -p 8642:8642 nousresearch/hermes-agent gateway run`.
- Setup: `docker run -it --rm -v ~/.hermes:/opt/data nousresearch/hermes-agent setup`.
- Env: `API_SERVER_ENABLED=true`, `API_SERVER_HOST=0.0.0.0`, `API_SERVER_KEY` (`openssl rand -hex 32`), `HERMES_DASHBOARD=1`, `HERMES_DASHBOARD_PORT=9119`, dashboard auth (`HERMES_DASHBOARD_BASIC_AUTH_*` | OAuth | OIDC | `HERMES_DASHBOARD_INSECURE=1`), `PUID`/`PGID`.
- Browser tools (Playwright) need `--shm-size=1g`. Resource: 2–4 GB RAM, 2 CPU. Multi-profile in one container: `docker exec hermes hermes profile create <name>` + per-profile gateway; per-profile logs `~/.hermes/logs/gateways/<name>/current`.
- Custom model/provider via `config.yaml` `model.provider: custom`, `base_url`, `api_key`.

**Multi-profile gateways:** run N profiles as managed services (systemd/launchd) on one machine, each independent (own token/sessions/memory). Docs are thin on multiplexing one HTTP port across profiles → **treat each tenant profile as its own gateway/port (or its own container) rather than assuming one port fans out.**

---

## The Hermes Agent config contract (Phase 1 deliverable)

One tenant = one Hermes **profile** (the "external agent brain"); multiple internal workflows (competitors/forms/inbox) live inside it as skills/cron. Config object stored in hm-core, owned by hm-control:

```jsonc
{
  "agent_id": "uuid",                       // hm-core PK
  "name": "Competitor Watcher",
  "tenant_id": "org_<uuid>",                // 1 runtime = 1 tenant brain
  "hermes_profile": "org-<id>",             // maps to a Hermes profile (isolation unit)
  "distribution": "github.com/davinci/hermes-competitor-watcher",  // git template (optional)
  "memory_mode": "hivemind_mcp",            // ALWAYS HiveMind MCP as SoR (never local memories/)
  "capabilities": ["browser", "web_search", "forms", "inbox"],     // Hermes toolsets enabled
  "schedule": { "type": "manual|cron", "expr": "13,43 * * * *" },   // manual for MVP
  "output_routes": [                        // where results go
    { "type": "hivemind_memory", "tenant_id": "org_<uuid>", "tags": ["competitor"] },
    { "type": "webhook", "url": "https://hm-control/internal/hermes/callback" }
  ],
  "safety_policy": {
    "max_tokens_per_run": 100000,
    "allowed_domains": ["*"],               // restrict for forms/inbox
    "require_approval": ["send", "purchase", "form_submit"],  // human-gate side effects
    "max_runtime_seconds": 600
  },
  "model": { "provider": "custom", "model": "...", "base_url": "...", "api_key": "env:..." },
  "soul_ref": "distribution|inline",        // SOUL.md source
  "status": "active|paused"
}
```
hm-control surface: `createRuntime/updateRuntime/destroyRuntime` (lifecycle), `runOnce(agent_id, payload)` (start a Hermes job → POST to that profile's gateway `:8642`), `getStatus(job_id)` + `getLogs(job_id)` (poll/stream). FE never talks to Hermes directly.

---

## Phased plan (one phase per cron run; each small, verifiable, deployable)

- **Phase 1 — Config contract.** Add the Hermes Agent JSON schema + a validator + one sample (`Competitor Watcher`) to hm-core. No infra. **Verify:** validator accepts sample, rejects malformed; `node --check`. Deployable (additive, dormant).
- **Phase 2 — `hm-hermes` image + compose.** Dockerfile from `nousresearch/hermes-agent:latest` (+ `--shm-size`, resource limits) + a shim that reads a task spec from hm-control and invokes Hermes; add `hm-hermes` service to `docker-compose.coolify.yml` with `/opt/data` volume, ports 8642/9119, `API_SERVER_ENABLED`, generated `API_SERVER_KEY`. **Verify:** container boots, `GET :8642` health + dashboard reachable; state persists across restart.
- **Phase 3 — HiveMind MCP wiring.** Profile `mcp.json` registers HiveMind MCP (`HIVEMIND_API_URL`, key, tenant ctx); set memory providers so recall/search/save default to MCP. **Verify:** a Hermes session performs a recall + a save that lands in HiveMind (check via API), not local `memories/`.
- **Phase 4 — hm-control Hermes client.** In hm-control add the internal service client: `runOnce(agent_id, payload)` → profile gateway; status + log poll/callback endpoint. **Verify:** hm-control starts a trivial job and reads its status + logs; FE→hm-control path only (no direct FE→Hermes).
- **Phase 5 — Competitor Watcher end-to-end.** Build the `hermes-competitor-watcher` distribution (SOUL + browser/web_search skills + output route → HiveMind memory). Manual trigger. **Verify:** `FE → hm-control → Hermes → browser/search → HiveMind MCP → result saved + shown in UI`. Cold-tests green.
- **Phase 6 — GATE: pods-per-client.** ONLY after Phase 5 loop is solid + observed. Design multi-tenant isolation (profile-per-tenant in shared container vs container/pod-per-tenant), resource caps, secret scoping. Do not start before the gate.

---

## Safety notes (inherited every run)
- RULE 0: finish existing work first; no dead/duplicate code.
- No destructive ops (no DROP/down-migrate/purge/data delete). Hermes local state ≠ SoR; memory SoR is HiveMind.
- Prod runs DRIFT → never `git pull` on server; deploy = surgical checkout/scp + restart + rollback; auto-rollback on RED.
- Secrets (`API_SERVER_KEY`, HiveMind key, model keys) via env only — never committed; never in a distribution repo.
- Side-effectful Hermes actions (send/submit/purchase) gated by `safety_policy.require_approval`.
- One phase per run. Stop + log in JOURNAL if ambiguous or work-loss risk.


---

# Phase 6 (detailed) — pods-per-client architecture
*Designed 2026-06-06 via parallel workflow wd4qoyvvi (5 design agents). Supersedes the Phase 6 stub above.*

## Phase 6 — GATE: pods-per-client (hm-hermes-manager)

> **Precondition (hard gate):** Do NOT start before the Phase 5 single-container loop is solid and *observed* in prod. This phase adds per-tenant Hermes runtimes; the shared `hm-hermes` container remains the fallback until 6f flips routing.

**What this owns:** per-tenant Hermes runtime lifecycle on the **single Hetzner host** via the **Docker API** (dockerode / docker CLI) — `createRuntime(tenant_id)`, `start/stop/restartRuntime`, `runTask(tenant_id, agent_id, task_spec)`. One tenant → one container `hm-hermes-<tenant>` (image `hm-hermes`, volume `hermes-state-<tenant>`), reusing the **existing** Docker networks (compose `hivemind-network`; the live container is also on `hmtest` + `s0k0_hivemind`) — **no new per-tenant bridge networks in MVP**. All FE→Hermes traffic is mediated by `hm-control` (`control-plane-server.js`, never `server.js`).

**Docker now, Kubernetes later (explicit decision):** this stack is **Docker + Coolify on one host — there is NO Kubernetes**. The implementable path is the Docker API managing per-tenant containers on the single host. K8s (Deployment/StatefulSet replica=1 per tenant, PVC `hermes-state-<tenant>`, ClusterIP Service, optional CronJob, Secret-per-tenant) is the **documented long-term migration target, not built now**. The registry schema is designed forward-compatible (e.g. allow a future `container_host` field) so the same APIs survive a multi-host/K8s move.

**Placement decision (resolve in 6a):** implement the manager as a **Node module inside `hm-control`** (single deploy boundary; reuses the existing `hm-control-client.js` which already accepts `{baseUrl, apiKey}`, plus existing auth/org-scoping) — **or** a Python FastAPI sidecar mirroring `employees-service` if a separate boundary is required. Pick one in 6a before writing lifecycle code.

### Ordered sub-phases (one per cron run; each small, verifiable)
| ID | Goal | Deployable | Human-gated |
|----|------|------------|-------------|
| 6a | Pick placement/language; freeze `runtime-spec.schema.json`; resolve network/secret reality on paper | yes | no |
| 6b | Additive `hermes_runtimes` registry migration (no behavior) | yes | no |
| 6c | Docker orchestrator module (create/start/stop/restart/status/logs/delete) — local/staging socket only | no | no |
| 6d | Per-tenant resolver wired to existing `runOnce`/`checkHealth` + startup reconciliation (drift = alert, no auto-recreate) | no | no |
| 6e | Mediated `hm-control` `/v1/hermes/*` routes + `hermes_jobs` audit; default-off via `HERMES_MANAGER_ENABLED` | yes | no |
| 6f | **GATE:** first real tenant in prod — ops review of docker.sock/secrets/resource-cap/rollback, then create container + flip routing | yes | **yes** |
| 6g | **GATE:** per-tenant scoped MCP tokens + rotation, admission control, isolation test, onboard 2-3 tenants | yes | **yes** |

### Reuse / finish-first (no net-new where it exists)
- `hm-control-client.js` `runOnce/checkHealth/getStatus` — **already** take `{baseUrl, apiKey}`; add only a per-tenant resolver, no client edit.
- `agent-config.js` validator + schema (Phase 1) — reuse for task payloads and mirror its ajv test for the new runtime spec.
- Same `hm-hermes` image for all tenants (no per-tenant rebuild); reuse existing networks + `/opt/HIVEMIND/.hm-hermes.env`.
- `employees-service` per-tenant orchestration — **pattern reference only** (copy structure, not code), and only if 6a chooses the sidecar option.

### Safety (inherited every run)
- Prod is DRIFT: never `git pull` on server; deploy = surgical `git checkout origin/<branch> -- <file>` (or scp) + restart + rollback; verify with `cold-tests/run-all.mjs` via `deploy-verified.sh`.
- **Never** edit `core/src/server.js`; extend `control-plane-server.js` only.
- Migrations additive + backward-compatible; **no** DROP/down-migrate/volume purge without an explicit approval token.
- Secrets via env-file only — never in args/inspect, never committed, never in a distribution repo.
- `docker.sock` access is root-equivalent → infra-reviewed (human-gated) before any prod container creation.
- Per-tenant prod container creation **and** the `HERMES_MANAGER_ENABLED` routing flip are **human-gated** (6f/6g). One phase per run; stop + log in JOURNAL on ambiguity or work-loss risk.
