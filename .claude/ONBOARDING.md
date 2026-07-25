# HIVEMIND — Claude Code onboarding

This `.claude/` is tuned to run Claude Code at high speed on HIVEMIND: **recon before building, reuse over rebuild, verify before shipping.** New contributor? Read this once.

## Golden loop
1. **Recon first** — never build blind. `/feature-recon "<the feature>"` (skill) or the `feature-recon` **workflow** (parallel graph + git + HIVEMIND-memory → reuse/extend/build verdict). A partial hit turns "build" into "extend". This is the #1 time saver.
2. **Build** — follow existing patterns; `hivemind-dev` skill has the add-feature / fix-bug / refactor flows. Backend is ESM Node/Express/Prisma in `core/`; FE is the `Da-vinci` submodule (CRA + Tailwind, see the `hivemind-frontend` skill for tokens).
3. **Review** — run the `review-changes` workflow on your diff (bugs / tenant-isolation / perf / db-migration / standards, each skeptic-verified) before you commit.
4. **Ship** — the `ship` skill: commit (correct author) → push → pull on prod → migrate → restart hm-core → smoke + recall-eval. Then the `deploy-verify` workflow confirms the box is in sync + healthy + un-regressed.

## Curated assets
- **Skills** (`.claude/skills/`): `feature-recon`, `hivemind-dev`, `ship`, `hetzner-ops`, `qdrant-ops`, `mcp-integration`, `debug-issue`, `refactor-safely`, `review-changes`, `explore-codebase`. Global also: `hivemind-apex` (full repo manual + fix playbook), `hivemind-frontend`, `hermes-agents-builder`.
- **Workflows** (`.claude/workflows/`, invoke via the Workflow tool by `name`): `feature-recon`, `review-changes`, `deploy-verify`.
- **`.claude/scripts/hm`** (maintainer-only): prod ops dispatcher — `hm status|logs|sync|smoke|eval|psql` (read-only) and `hm deploy|restart|migrate` (DRY-RUN unless `--confirm`; `deploy` bakes in the box-patch hazard handling + migrate gate + post-deploy smoke/eval). Needs the `myserver` SSH alias + `HM_MASTER_KEY`. Contributors don't use this — it drives production.
- **Agents** (`.claude/agents/`): `HIVEMIND-APEX` (surgical fixer), `cartographer` (blast radius), `historian` (why is it like this), `implementer-backend|frontend|infra`, `code-reviewer`, `security-reviewer`, `db-reviewer`, `deploy-operator`, `e2e-runner`, `mcp-specialist`, `nango-specialist`, `memory-curator`, … fan out for parallel independent work.
- **CLAUDE.md** (repo root) — graph-first + HIVEMIND memory-discipline rules, loaded every session.

## Memory discipline (this repo persists across sessions)
- Bootstrap recall at session start (CLAUDE.md has the exact calls).
- After meaningful work: `hivemind_log_decision` / `hivemind_save_memory` (tagged `session-trail-<date>`), `hivemind_ingest_code` after real edits.
- Before touching unfamiliar/known-buggy code: `hivemind_why_code` / `hivemind_recall_bugs`.

## Local dev — do NOT use the prod box
- Bring up the stack locally: `docker-compose.local-stack.yml` (Postgres + Qdrant + Redis + core). Copy `.env.example` → `.env` with **dev-only** keys + **synthetic** seed data. Never a prod dump (GDPR).
- `myserver` is **production** (live `hm-core`, real customer data, master key, OAuth/Nango secrets). Contributors never get SSH to it and never see prod secrets.
- Workflow for contributors: **feature branch → PR against `main` → review + CI green → a maintainer deploys.** No direct push to `main`, no deploy rights, scoped (non-master) API key only.

## Invariants
- Commit author: `amarsai3012005 <amarsai3012005@users.noreply.github.com>`.
- Stage explicit paths only (the tree has unrelated modified files) — never `git add -A`.
- ESM everywhere (`"type": "module"`). Backward-compatible migrations with a down path. Tenant-scope every query. No secrets in source.

---

# PRODUCTION DEPLOY — read this before touching the live box

Hard-won rules. Every one of these cost a real incident or a long debug. Full
detail: [`TARA_GROK_DEPLOYMENT.md`](../TARA_GROK_DEPLOYMENT.md).

## 1. Which tree do I build from?
| Path | What it is | Use for |
|---|---|---|
| `/root/hivemind-main` | canonical, clean | **BUILD here** |
| `/root/hivemind` | dirty (`feat/mneme-foundation`), holds `.env` | **RUN compose here** — never a build source |
| `/root/hivemind-next` | stale duplicate of `singulance-main` | **never** |

The live stack is compose project **`hivemind`** using
**`/root/hivemind/infra/docker-compose.hetzner.yml`**. Prove it, don't assume:
`docker inspect <ctr> --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}'`

## 2. Deploy ONE service, never the stack
Every service shares `image: …:${VERSION:-latest}`, so a bare `up` reconciles
**everything** to the new tag. Always name the service, always `--no-deps`, and
always dry-run first — the plan must show every other container as `Running`:
```bash
cd /root/hivemind-main && docker build -f Dockerfile.production -t hivemind/core-api:$TAG .
cd /root/hivemind
VERSION=$TAG docker compose --env-file /root/hivemind/.env -f infra/docker-compose.hetzner.yml up -d --no-deps --dry-run core   # GUARD
VERSION=$TAG docker compose --env-file /root/hivemind/.env -f infra/docker-compose.hetzner.yml up -d --no-deps core             # DEPLOY
```
Pin a rollback tag (`docker inspect <ctr> --format '{{.Config.Image}}'`) BEFORE building.
Use an **absolute** `--env-file` path — a relative one silently resolves against your cwd and the deploy fails.

## 3. NEVER run `prisma migrate deploy`
History is abandoned: 34 recorded applied, **77 "pending"**, one recorded
**failed** — while the objects those "pending" migrations create already exist.
Core logs `Error: P3005` at boot for this reason: **known, pre-existing, non-fatal.**
Apply schema as idempotent DDL instead, then record it:
```bash
cat core/prisma/migrations/<name>/migration.sql | docker exec -i hm-postgres psql -U hivemind_user -d hivemind -v ON_ERROR_STOP=1 --single-transaction
```
**Pre-flight every new UNIQUE index against live data** — a duplicate row aborts
the migration and leaves a failed record that blocks all future ones. (`tara_turns`
had two `seq=1` rows; fixed by renumbering, never deleting.)
DB: user `hivemind_user`, db `hivemind`, app schema `hivemind`, but `_prisma_migrations` lives in **`public`**.

## 4. The FE is not compose-managed
Two plain `docker run` containers off `hivemind/fe:latest`:
- `hivemind-next-frontend-1` — network `hivemind-next`, `127.0.0.1:2388:80` → **THE APP**
- `hm-fe` — bridge, `8088:80` → marketing only (`/hivemind*` 301s to next)

Backend URLs are baked at build time (Dockerfile ARG defaults are already correct).
Submodule `frontend/Da-vinci` is its own repo — **check its HEAD matches the parent
gitlink** (`git ls-tree HEAD frontend/Da-vinci`) or you ship stale code.
**CRA code-splits routes:** a page's code lives in `NNNN.*.chunk.js`, NOT `main.js`.
Grepping `main.js` and finding nothing is not a failed deploy — grep `/srv/static/js/*`.

## 5. Editing a single-file bind mount (Caddyfile)
`hm-caddy` (network_mode **host**) mounts `/root/hivemind/infra/Caddyfile` as a FILE.
Write/Edit tools **rename**, creating a new inode — the container keeps reading the
old one and `caddy reload` says "config is unchanged". Diagnose with `stat -c %i`
host vs container. Fix without restarting:
```bash
cat /root/hivemind/infra/Caddyfile | docker exec -i hm-caddy sh -c 'cat > /etc/caddy/Caddyfile'
docker exec hm-caddy caddy validate --config /etc/caddy/Caddyfile   # ALWAYS before reload
docker exec hm-caddy caddy reload   --config /etc/caddy/Caddyfile
```

## 6. A feature usually spans THREE services
core + control-plane + FE. Deploying one and testing is how you get "it doesn't
work" reports. The FE calls the **control plane** (`api.singulancelabs.com/v1/*`),
which proxies to core (`/api/*`).
**Triage an endpoint by status code:** `404` = route missing → that service is stale;
`401` = route present + auth-gated → correct; `403` on `/api/tara/*` with a master-key
curl and no `x-hm-user-id` = test artifact, not a bug.

## 7. Verify like a hostile reviewer
- Uptimes prove nothing was recreated (`docker ps` — untouched services keep their old uptime).
- Check the *public* URL, not just the container.
- Read the actual log line; a silent close is a missing log, not a healthy path
  (a 403 WS handshake with no reason cost hours — add the log).
