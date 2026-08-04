# Singulance Cloud Architecture And Recovery Deployment Guide

_Last updated: 2026-08-04_

This is the single source of truth for **current production architecture** and a **reproducible recovery/deploy path**.

It is intentionally operational: every decision above-the-fold should be tied to this file plus the immutable release scripts in `/root/hivemind/scripts`.

## 1) Core runtime topology (what is live today)

At runtime, all API and execution traffic is routed through Caddy and then into the private loopback services:

- `https://api.singulancelabs.com` → `hm-control` (`127.0.0.1:2027`) unless a route is `/v1/byod/*` or `/v1/hq/events/stream`.
- `https://core.singulancelabs.com` → `hm-core` (`127.0.0.1:2026`).
- `https://next.singulancelabs.com` and `https://singulancelabs.com` default route → frontend (`127.0.0.1:2388`).
- `https://admin.hivemind.singulancelabs.com` → frontend runtime entrypoint `/hivemind/app/platform-admin` normalization.
- `https://nango.singulancelabs.com` → nango server (`127.0.0.1:3003` in compose).
- `https://core.singulancelabs.com/voice2/*` → `tara-deepgram` (`127.0.0.1:8091`).
- `https://core.singulancelabs.com/voice-grok/*` → `tara-grok` (`127.0.0.1:8092`).
- `https://singulancelabs.com/api/waitlist*` → embedded waitlist service (`localhost:8095`).

### Runtime call path

1. Browser / API client hits hostname on `Caddyfile`.
2. Edge strips/rewrites/redirects and proxies to the host-loopback port.
3. Core and control-plane authenticate + validate artifacts/entitlements from PostgreSQL.
4. Control-plane writes/reads execution state in PostgreSQL and dispatches specialist work through Employees sidecar.
5. Specialized providers (grok/deepgram/Nango, etc.) are called through adapters, never directly by the FE.

### Why this matters

- **Separation of concerns**: frontend (React runtime UI) does not own specialist execution.
- **Single source of truth**: PostgreSQL owns execution + lifecycle.
- **Single writer for runtime actions**: one release lock and one control plane source-of-truth avoid “last deploy wins” race conditions.

## 2) Canonical services and compose ownership

Use these files for deployment truth:

- Compose: `/root/hivemind/infra/docker-compose.hetzner.yml`
- Edge: `/root/hivemind/infra/Caddyfile`
- Release scripts: `/root/hivemind/scripts/release-canonical.sh`, `/root/hivemind/scripts/release-lock.sh`, `/root/hivemind/scripts/release-verify-runtime.sh`

| service | container | compose role | host binding | notes |
|---|---|---|---|---|
| core | `hm-core` | Core API + orchestration primitives | `127.0.0.1:${CORE_PORT:-2026}` | Built from `Dockerfile.production` |
| control-plane | `hm-control` | HQ Runtime / execution scheduler | `127.0.0.1:${CONTROL_PORT:-2027}` | Built from `Dockerfile.control-plane` |
| employees | `hm-employees` | Rooms sidecar / director entry | internal sidecar `PORT=8060` | Built from `employees-service` |
| postgres | `hm-postgres` | Execution and application DB | no host port exposed in production |
| redis | `hm-redis` | transient state/cache & queue support | no host port exposed |
| qdrant | `hm-qdrant` | semantic + vector store | no host port exposed |
| docling | `hm-docling` | document ingestion engine | no host port exposed |
| byod-broker | `hm-byod-broker` | BYOD API enrollment | `127.0.0.1:8790` |
| nango | `hm-nango` | connector runtime callbacks | `127.0.0.1:${NANGO_PORT:-3003}` |
| tara-deepgram | `tara-deepgram` | voice runtime provider | `127.0.0.1:8091` | built from `services/tara-deepgram` |
| tara-grok | `tara-grok` | alternative voice provider | `127.0.0.1:8092` | built from `services/tara-grok` |
| frontend image | `hivemind-next-frontend-1` | Runtime/UI | `127.0.0.1:2388` | built from `/root/hivemind-next/infra` profile single |

## 3) Frontend strategy and routing notes

- Current production frontend is **single-profile** in `hivemind-next` with image name `hivemind/fe`.
- `next.singulancelabs.com` and `singulancelabs.com` use one runtime frontend route.
- `admin.hivemind.singulancelabs.com` is route-normalized in Caddy to `/hivemind/app/platform-admin`.
  - this avoids duplicated `/overview/overview/...` loops and keeps the admin page in the same host.

## 4) Runtime contracts and truth

### Core truths (do not bypass)

- `PostgreSQL` stores work orders, playbook runs, checkpoints, artifacts, authority, and event timeline.
- `hivemind-data` volume stores `.amr` memory artifacts for orgs with MNEME enabled.
- `Core/Control/Employees` are the only components that persist execution state and artifact decisions.

### Frontend must never act as an execution authority

The FE can only display facts, request permission, and forward user decisions.

- No direct outbound action from FE.
- No direct retry logic from FE.
- Any action is re-checked by control-plane playbook contracts before execution.

## 5) Storage and data classes

Key Docker volumes on host:

- `hivemind-data` (critical): `.amr` memory files, shared byod registry artifacts
- `postgres-data`
- `redis-data`
- `qdrant-data`
- `docling-models`
- `byod` and Playwright volumes (as configured)

Recommended minimum backup:

- Postgres dump every hour (plus PITR where possible)
- Volume snapshot or tar backup for `hivemind-data` and `qdrant-data`
- Weekly restore drill in non-production environment

## 6) Environment and secret inputs

At minimum for production bootstrap:

- `/root/hivemind/.env` plus `/root/hivemind/.env.firecrawl` (where Firecrawl is enabled)
- Database/cache/vector/identity secrets (`POSTGRES_*`, `REDIS_PASSWORD`, `QDRANT_API_KEY`)
- Master/admin keys (`HIVEMIND_MASTER_API_KEY`, `HIVEMIND_ADMIN_SECRET`, `SESSION_SECRET`)
- OAuth/OIDC client config used by runtime
- Provider keys used by current enablement (`OPENROUTER_API_KEY`, `GROQ_API_KEY`, etc.)
- Nango credentials (`NANGO_SECRET_KEY`, `NANGO_ENCRYPTION_KEY`, `NANGO_PUBLIC_URL`)
- TARA runtime keys (`TARA_DG_*`, `TARA_GROK_*` as applicable)

If any listed secret is missing at deploy, release should fail before `up`.

## 7) Governance and safe release discipline (canonical flow)

### Golden invariant

**No direct deploy from local feature trees.** Always release from merged `singulance-main` SHA:

- `/root/hivemind` (production control scripts)
- `/root/hivemind-main` (canonical app source)
- `/root/hivemind-next` (frontend compose/worktree)

### Why this exists

This prevents stale or partial history from being shipped when multiple sessions work in parallel.

### Release command map

- Immutable build + deploy: `scripts/release-canonical.sh --sha <merged-singulance-main-sha> --services <svc-list>`
- Concurrency lock: `scripts/release-lock.sh`
- Service verification: `scripts/release-verify-runtime.sh --service <name>`

## 8) New one-button recovery for downed server

If you have:

- the git repos (`/root/hivemind`, `/root/hivemind-main`, `/root/hivemind-next`)
- and valid `.env` files

you can recover in minutes with:

1. Validate env and latest remote sha.
2. Rebuild required services from canonical SHA.
3. Redeploy only target services with `--no-deps`.
4. Run signed-in smoke checks.

See script section below for exact commands.

## 9) Deploy script (same folder): `.claude/decision-docs/deploy-singulance-cloud.sh`

This is a production-safe wrapper around `release-lock.sh` + `release-canonical.sh`.

### What it does

- Validates SHA exists in `/root/hivemind-main` and is an ancestor of `origin/singulance-main`.
- Runs with the shared deploy lock to prevent clobber.
- Optionally validates compose config and canary reachability.
- Rebuilds immutable image tags only (`sha-...`).
- Deploys named services with `--no-deps`.
- Triggers runtime verification for each service.
- Prints a short manifest and explicit rollback key.

### Service map for script

- `core`
- `control-plane`
- `employees`
- `tara-grok`
- `tara-deepgram`
- `frontend`

## 10) Script usage

```bash
cd /root/hivemind/.claude/decision-docs
chmod +x deploy-singulance-cloud.sh

# Typical full redeploy
./deploy-singulance-cloud.sh \
  --sha $(git -C /root/hivemind-main rev-parse origin/singulance-main) \
  --services core,control-plane,employees,frontend,tara-grok,tara-deepgram \
  --canary-url https://next.singulancelabs.com/hivemind/app

# Fast safety recovery (critical path) after an outage
./deploy-singulance-cloud.sh \
  --sha $(git -C /root/hivemind-main rev-parse origin/singulance-main) \
  --services core,control-plane,employees,frontend \
  --skip-canary

# Dry run only
./deploy-singulance-cloud.sh \
  --sha $(git -C /root/hivemind-main rev-parse origin/singulance-main) \
  --services core \
  --dry-run
```

## 11) Post-deploy verification checklist

- `scripts/release-verify-runtime.sh --service core`
- `scripts/release-verify-runtime.sh --service control-plane`
- `scripts/release-verify-runtime.sh --service employees`
- `scripts/release-verify-runtime.sh --service frontend`
- `docker ps --format '{{.Names}}\t{{.Status}}\t{{.Image}}'`
- Browser smoke paths:
  - `https://next.singulancelabs.com/hivemind/app`
  - `https://admin.hivemind.singulancelabs.com/`
  - `https://api.singulancelabs.com/v1/health`
  - `https://api.singulancelabs.com/v1/hq/work?ts=<now>` (preflight CORS expected in logs)

## 12) Known recovery footnotes

- Do **not** delete uncommitted active branch work unless explicitly approved.
- Do **not** run `git pull` into dirty shared deployment trees as recovery.
- If the shared lock complains about disk, prune only after confirming no active release/build and keeping required rollback tags.
- Keep `hivemind-next` separate; it is a dedicated stack and must be launched by production workflow only through the release wrapper.

---

# PART II — Verified addenda (2026-08-04)

> Everything below was checked against the running box on 2026-08-04, not inferred.
> §§1–12 above were audited and found **accurate**: all 12 services in the §2 table are running,
> and every domain in §1 exists in the Caddyfile. The additions here close gaps that would
> break a real recovery.

## 13) Containers running but NOT in the §2 table

A recovery driven off §2 alone would miss these. `hm-caddy` is the most serious: **it is the edge
itself**, so nothing in §1's routing exists without it.

| container | role | why it matters for recovery |
|---|---|---|
| `hm-caddy` | **The edge.** Terminates TLS and owns every route in §1. | Restore this first; without it no hostname resolves to anything. |
| `hm-byod-agent` | BYOD `.amr` agent, `:8787` | Holds a tenant's memories. See §16. |
| `hm-byod-postgres` | BYOD stack's own Postgres | Separate from `hm-postgres`. |
| `hm-byod-qdrant` | BYOD stack's own Qdrant | Separate from `hm-qdrant`. |
| `waitlist-relay` | Serves `singulancelabs.com/api/waitlist*` (§1 names the route, not the container) | Public marketing path. |
| `hm-playwright` | Browser automation for HQ Runtime / TARA browser sessions | |
| `bench-pg`, `stoic_carver` | Benchmark / scratch containers | **Not production.** Safe to ignore; do not restore. |

**Rule.** Treat `docker ps` as the source of truth over this table, and update the table when it
diverges. A service table that is merely *plausible* is worse than none during an outage.

## 14) The frontend is the most trap-laden part of a deploy

Three facts that are not obvious and each caused a wrong deploy in practice:

1. **`hm-fe` no longer exists and must not come back.** It was a duplicate legacy container on
   `:8088`. Removed 2026-08-04. The live frontend is **only**
   `hivemind-next-frontend-1` on `127.0.0.1:2388`, which is what `next.singulancelabs.com`
   actually resolves to. Verified: `hm-fe` container count = 0.

2. **`scripts/deploy-fe.sh` updates the WRONG container.** It builds and recreates `hm-fe`
   (`:8088`). Running it today deploys to something nobody is looking at, reports success, and
   leaves the real frontend untouched. Use the `hivemind-next` compose path (below) instead.

3. **The live FE image is pinned by a file in `/tmp`.** Confirmed from the container's own labels:
   ```
   com.docker.compose.project.config_files =
     /root/hivemind-next/infra/docker-compose.next.yml,/tmp/hm-tara-frontend-override.yml
   ```
   `/tmp/hm-tara-frontend-override.yml` is three lines pinning `image:`. **This is fragile** —
   `/tmp` is not durable across reboots, and two sessions have overwritten it. Deploying the FE
   therefore means editing a temp file. **Action item: move that pin into
   `docker-compose.next.yml` and delete the override.** Until then, a reboot loses the pin and
   compose falls back to the stale `image:` line in the compose file.

**Correct FE deploy, verbatim:**
```bash
# 1. commit + push to Da-vinci main (the build REFUSES a commit that is on no remote)
# 2. build from a throwaway worktree of that commit — deploy-fe.sh's build half does this correctly
#    and no longer resets the shared tree (it used to; that was fixed)
# 3. pin and recreate the container that is actually served:
docker inspect hivemind-next-frontend-1 --format '{{.Config.Image}}' > /root/hivemind/.last-next-fe-rollback
# edit /tmp/hm-tara-frontend-override.yml -> image: hivemind/fe:sha-<9char>
/root/hivemind/scripts/release-lock.sh docker compose -p hivemind-next \
  --env-file /root/hivemind-next/.env.embedding-canary-runtime \
  -f /root/hivemind-next/infra/docker-compose.next.yml \
  -f /tmp/hm-tara-frontend-override.yml \
  --profile single up -d --no-deps frontend
```
Note the env-file is **`.env.embedding-canary-runtime`**, not `.env` — taken from the running
container's own labels. Using the wrong one fails on
`required variable NEXT_HIVEMIND_MASTER_API_KEY is missing`.

## 15) Build verification rules (a passing grep is not a passing build)

**Docker silently reused a stale `COPY` layer twice on 2026-08-04**, once on core and once on the
frontend, shipping images that did not contain the committed source.

- **Core symptom:** `/app/src/memory` had **53 files instead of 61**;
  `canonical-entity-persister.js` was absent entirely.
- **Frontend symptom:** 104 JS chunks, **zero** containing any of the new markers, despite the
  image's gitlink pointing at source that had them.

**Why marker-greps missed it:** grepping for a string inside a **file that does not exist** returns
nothing, which reads identically to "no problem here".

**Rules:**
1. **Verify by file count as well as content.**
   `docker run --rm --entrypoint sh <image> -c 'ls /app/src/memory | wc -l'` — compare with the
   worktree. A count mismatch is a corrupt build regardless of what greps say.
2. **Use `--no-cache` whenever the change ADDS or RENAMES a file.** Content edits usually
   invalidate the layer; new files have been observed not to.
3. **For the frontend, verify in the SERVED bundle, and search every chunk.** CRA code-splits
   routes, so a page's code is in a lazy chunk, not `main.*.js`. Grepping only `main.js` will
   report a correct build as broken.
4. **Local `const` names are minified away.** Grep for **string literals**, which survive, or
   compare the compiled expression between old and new images.

## 16) `.amr` recovery — the backup guidance in §5 is incomplete and will lose data

§5 says `hivemind-data` holds the `.amr` files, which is true. The dangerous part is the implication
that restoring it restores an `.amr` tenant. **It does not.** Measured for one `amr_embedded` org:

| layer | actually stored in |
|---|---|
| memories, memory vectors, memory text, graph edges | **the shard** — `/app/data/mneme/<orgId>/{shard.amr,.vec,.txt,.edg}` |
| **evidence / KB segments** | Postgres `hm.knowledge_segments` |
| documents | Postgres `hm.knowledge_documents` |
| **evidence vectors** | Qdrant collection `org_<orgId with _ for ->` |
| **entities + memory↔entity links** | central Postgres `hivemind.canonical_entities`, `memory_entity_links` |
| PQC signatures | central Postgres `hivemind.memory_signatures` (`alg = ML-DSA-65`) |
| SQL mirror of memories | Postgres `hm.memories` — what the Postgres-FTS lexical lane reads |

**A complete `.amr` tenant restore therefore needs FOUR sources, consistent with each other:**
1. the shard directory from `hivemind-data`
2. the `hm` schema
3. the central tables (`canonical_entities`, `memory_entity_links`, `memory_signatures`)
4. the per-org Qdrant collection

**Rule.** Snapshot all four at the same point, or the tenant comes back with memories that have no
evidence, no entities and unverifiable signatures — and **recall will silently return less** rather
than error. Restoring Postgres without sweeping Qdrant also leaves orphan vectors, which look
exactly like a broken retriever.

**Also unaddressed (open risk, not a rule):** nothing calls the shard's `compact()` — the native
binding exposes it and there are zero call sites — so shard files grow without bound. Observed:
`shard.vec` at **4.2 MB for 11 live memories**. And there is no shard WAL, standby or snapshot
path; `scripts/` contains only `backup-postgres.sh`. **A dead box is still an offline org.**

## 17) Deploy mechanics that are not optional

1. **Compose needs `--env-file` explicitly.**
   ```bash
   cd /root/hivemind/infra && /root/hivemind/scripts/release-lock.sh \
     docker compose --env-file /root/hivemind/.env \
     -f docker-compose.hetzner.yml up -d --no-deps core
   ```
   Without it: `required variable PLAYWRIGHT_SERVICE_TOKEN is missing`. The `env_file:` key in
   compose feeds the **container**, not compose's own `${VAR}` interpolation, and compose looks for
   `.env` in the project dir (`infra/`), not `/root/hivemind/.env`.

2. **The 25 GB release-lock floor bites twice per deploy** — once for the build, again for the
   recreate, because the build consumes the headroom. `docker system df` reporting
   `Build Cache … RECLAIMABLE 0B` is **misleading**: `docker builder prune -f` still freed
   12.25 GB and 2.26 GB on successive runs. Reclaim order that is safe:
   `docker image prune -f` (dangling only) → `docker builder prune -f` → `builder prune -a -f`
   if still short. **Never `image prune -a`** — it deletes other sessions' `sha-*` rollback tags.

3. **`singulance-main` cannot be checked out or force-updated locally** — it is held by another
   worktree (`/root/builds/workspace-admin-*`), so `git branch -f` and `git checkout` hard-fail.
   Merge by pushing the ref: `git push origin <branch>:singulance-main`. A plain (non-forced) push
   is the safety: it refuses if another session pushed first.

4. **`origin/singulance-main` moves during a release.** It moved **five times** in one session.
   Always `git fetch` and rebase immediately before building, and re-check afterwards — otherwise
   the image you just built is already behind the ref you are deploying.

5. **Always record the rollback tag BEFORE `docker rm`.** Inspecting a removed container yields
   nothing, leaving an empty rollback file exactly when it is needed. Files in use:
   `.last-core-rollback`, `.last-next-fe-rollback`.

## 18) `.env` is the live authority, not the code

Read `docker exec hm-core env` **before** reasoning about any tunable. `.env` overrode a code
default in three separate incidents on 2026-08-04, twice making a code change completely inert.

Model/behaviour variables that currently govern production:
```
KB_UNIFIED_MODEL=google/gemini-2.5-flash-lite       # fact extraction (4.3s; deepseek measured 291.6s here)
MEMORY_PROCESSOR_MODEL=deepseek/deepseek-v4-flash-0731
ENTERPRISE_EXTRACTION_MODEL=deepseek/deepseek-v4-flash-0731
KB_UNIFIED_FALLBACK_MODELS=deepseek/...,openai/gpt-oss-120b   # must be different FAMILIES
HIVEMIND_AGENT_RETRIEVAL_BUDGET_MS  (unset -> 12000; 3000 was below measured cold recall)
EMBEDDING_PROVIDER=litellm / EMBEDDING_FALLBACK_PROVIDER=openrouter (bge-m3, dim 1024)
PHASE_E_POOL_DAILY_BUDGET=3000000   # governance/dreaming pool; when spent, consolidation STOPS
MNEME_PERSONAL_DEFAULT=1            # new personal signups land on .amr
STRIPE_PRICE_ID_PRO / _SCALE        # both SET (an earlier doc said unset — stale)
```
**Rule.** A fallback chain must never list two variants of one model family — a retry then inherits
the same failure. And **a model swap invalidates every `max_tokens` sized for the old model**:
`finish=length` raises no error, it returns unparseable JSON, so it surfaces as a fallback storm and
doubled latency rather than an exception.

## 19) There is currently NO CI gate

`Lint & Test` and `Security Scan` report `failure` on pull requests, but **neither job ever runs**:

> "The job was not started because your account is locked due to a billing issue."

Five other checks show `skipped`. **Consequence:** no PR in this repo receives a real gate, and
releases merge on local verification only. Do not read a red check as a code failure without
opening the job — and do not read a green PR as evidence of anything until the billing lock is
cleared.

## 20) Rules, consolidated

**Release**
1. Only ever deploy a commit that is on `origin/singulance-main`. Never a local-only commit — if the
   worktree is pruned, the running code is unrecoverable.
2. Tag images by 9-char commit SHA. A date or label tag hides which code it contains.
3. Record the rollback tag before removing anything.
4. One release owner performs Compose edits and deploys. Parallel sessions may build and push
   independently, but **must not** deploy concurrently.
5. Wrap build **and** deploy in `release-lock.sh`, not just the deploy.

**Verification**
6. Verify in the **running container**, never from compose output. `Started` proves nothing.
7. Verify by **file count and content**. A grep on a missing file passes silently.
8. Reproduce the failure before fixing it, and re-run the reproduction after.
9. Force the race rather than observing its absence (e.g. 12 concurrent requests, not one).
10. **Your own probe is the first suspect.** A wrong client factory, a wrong endpoint shape and a
    wrong SQL column each produced a convincing false defect on 2026-08-04.

**Data**
11. Never turn a failed read into an empty result. Throw; let background callers opt into tolerance.
12. A timeout is not an absence — a lookup that failed must be able to say so.
13. Snapshot all four `.amr` sources together (§16), or accept silent partial loss.
14. Clearing Postgres without sweeping Qdrant leaves orphan vectors that mimic a broken retriever.

**Frontend**
15. Verify which container the hostname actually resolves to — read the Caddyfile, do not infer it
    from a deploy script's success message.
16. Check ancestry in **both** directions before superseding another session's FE release.
17. `hm-fe` stays deleted. One FE runtime: `hivemind-next-frontend-1`.

## 21) Correction log

Kept so the same wrong belief is not re-derived:

- **"Stripe price IDs are UNSET"** — stale. Both `STRIPE_PRICE_ID_PRO` and `_SCALE` are set.
- **"`deploy-fe.sh` does `git reset --hard` on the shared tree"** — no longer true; it builds from a
  throwaway worktree. It does, however, still target the wrong container (§14).
- **"30,000+ live PQC signatures"** — this box has **6,617** (`alg = ML-DSA-65`).
- **"`hivemind-data` is the sole copy for an `.amr` org"** — true of *memories only*; see §16.
- **`MNEME_HNSW_MIN` / `MNEME_HNSW_QUANT`** are **not set**, so any documented 50k threshold or
  quantisation behaviour is a code default, unverified in production.
