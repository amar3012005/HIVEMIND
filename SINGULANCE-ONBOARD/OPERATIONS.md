# Operations

> This describes the **current** production model on the single Hetzner host
> (`root@singulancelabs.com`, hostname `SINGULANCE`). It replaces the older
> immutable-per-SHA-tag "release dance". For the step-by-step ship/rollback
> commands see [SHIPPING.md](SHIPPING.md); for parallel-agent rules see
> [COLLABORATION.md](COLLABORATION.md).

## Deployment model (quick-deploy)

SINGULANCE runs Docker Compose on one 16 GB host. Deploys go through
`/root/quick-deploy.sh`, which enforces one simple, drift-proof model:

- **ONE live branch: `singulance-main`.** Developers push to it; the box pulls
  it. Live is always the tip of that branch — no worktrees, no per-SHA tags, no
  merge conflicts on the box.
- **Two checkouts, only one is the build source** (see the table below).
- **Two images per service, always:** `:latest` (what the live container runs)
  and `:stable` (the previous image, saved as a one-command rollback). Each
  deploy overwrites `:stable` with the outgoing `:latest`, so exactly one
  known-good rollback is kept per service and nothing accumulates.
- **Only changed services rebuild.** quick-deploy diffs the last-deployed SHA
  (`/root/.quickdeploy-last-sha`) against the new tip and rebuilds only the
  services whose files changed. Warm build cache is preserved (cache older than
  7 days + dangling images are pruned).
- **Migrations are applied before recreate.** New migration folders since the
  last deploy are backed up (pg_dump) then applied (idempotent SQL) before the
  service is recreated. The launcher chains `prisma migrate deploy && node …`,
  so a failed migration = no boot.
- **Health-gated.** Each recreated container must report healthy/running before
  the deploy proceeds; then a public smoke hits the four live URLs.

### The two checkouts (critical — do not confuse them)

| Path | Branch | Role | Rule |
| --- | --- | --- | --- |
| `/root/hivemind` | a feature branch (e.g. `feat/mneme-foundation`), intentionally dirty | Scratch / working checkout | **Never** pull, reset, or build from it. Its branch and tree do **not** represent production. A `DEPLOY-SOURCE.md` marker file lives here saying so. |
| `/root/hivemind-next` | `singulance-main`, kept clean | **The build source** (`REPO=/root/hivemind-next` in quick-deploy) | Every image is built here. quick-deploy force-checks-out `singulance-main` FETCH_HEAD before building, discarding any box-local drift. **Local commits here that were not pushed are lost on the next deploy** — push first. |

The live SHA is recorded in `/root/.quickdeploy-last-sha`. To verify production
lineage, compare that file to `git -C /root/hivemind-next rev-parse HEAD` — never
trust the branch shown in `/root/hivemind`.

## Live services and URLs

- Frontend: `next.singulancelabs.com` (container `hivemind-next-frontend-1`,
  image `hivemind/fe:latest-single`). A legacy `hm-fe` still runs `fe:latest`.
- Control plane: `api.singulancelabs.com` (`hm-control`, `control-plane:latest`).
- Core engine: `core.singulancelabs.com` (`hm-core`, `core-api:latest`).
- Voice sidecar: `tara-deepgram` (`tara-deepgram:latest`).
- Data services (never rebuilt by quick-deploy, never pruned): `hm-postgres`,
  `hm-qdrant`, `hm-redis`, plus `hm-nango`, `hm-caddy`, `hm-docling`,
  `hm-byod-broker`, `hm-playwright`.

Container names, images, and health are live facts — inspect `docker ps`,
`docker stats`, and the health endpoints before any change.

## Image hygiene (keep exactly latest + stable)

Historical build artifacts (candidate/prod/overlay tags) accumulate and eat the
root disk fast (core-api images are ~1.9 GB each). Keep **only** `:latest` and
`:stable` per service; base/third-party images stay. Deleting old *tags* that
are aliases of a live image only reclaims disk when the tag was the last
reference — that is expected. Never delete an image a running container uses, and
never delete PostgreSQL/Qdrant/Redis or customer volumes as "cleanup".

## Resource discipline and resilience

- Disk pressure is the immediate availability risk. Do not prune blindly:
  cleanup needs a dated inventory and a reviewed target list, not a generic
  `docker system prune`.
- Enforce resource limits, health checks, and restart policies for active
  services.
- Keep PostgreSQL and Qdrant backups encrypted, scheduled, freshness-checked,
  and restore-tested; add **off-host** encrypted delivery — local backups do not
  survive host loss.
- Monitor disk, memory, CPU, health, queue depth, error rate, and backup
  freshness; alert before saturation.
