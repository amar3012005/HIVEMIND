# HIVEMIND Deploy Runbook — NOW tier (immutable images + rollback)

> **SUPERSEDED FOR CURRENT SINGULANCE PRODUCTION.** Follow
> [`PRODUCTION_RELEASE_PROTOCOL.md`](./PRODUCTION_RELEASE_PROTOCOL.md). This file
> documents an older GHCR/multi-replica deployment design and its commands are not
> current production instructions.

**Problem this fixes:** prod ran stock `node:20` with `/opt/HIVEMIND/core` bind-mounted
and deployed by `git pull` on the box. No immutable artifact → drift (the box's
`main` once sat 383 commits behind on a stray branch; pulls aborted on local
drift). A bad commit was live the instant it merged, with no clean rollback.

**After this tier:** every push to `main` builds an immutable, test-gated image
`ghcr.io/<owner>/hivemind-core:<git-sha>`. Deploy = pull a tag, health-gate it,
swap. Rollback = redeploy the previous tag. Deterministic, no drift.

---

## Pipeline (automatic)

1. Push to `main` → `.github/workflows/build-image.yml`:
   - **Test gate**: `npm ci` + `node --check` all src + `node --test tests/unit/`.
     A red gate produces **no image** — a broken commit can never be deployed.
   - **Build + push**: `Dockerfile.production` → `ghcr.io/<owner>/hivemind-core:<sha>` + `:latest`.
2. Deploy that tag to prod (manual, deliberate — see below).

The image is verified-buildable (multi-stage, non-root, baked Prisma client,
`HEALTHCHECK` on `/health`, runs `prisma migrate deploy` then `node src/server.js`).

---

## Deploy a tag (on the prod host)

```bash
IMAGE_TAG=<git-sha> ./scripts/deploy-image.sh
```
What it does (and refuses to do):
- Pulls `ghcr.io/<owner>/hivemind-core:<sha>`.
- **Ephemeral smoke**: starts the image with the live env, waits for `/health`.
  If it never goes healthy → **exits without touching live traffic.**
- Swaps each replica (`hm-core`, `hm-core-2`) one at a time; the health-gated
  Caddy drains to the healthy replica during the swap.
- Post-swap health check per replica; **auto-reverts that replica** to `-old` if unhealthy.
- Records the tag in `/opt/HIVEMIND/.deploy/current-tag` (previous → `previous-tag`).

## Rollback (seconds, deterministic)

```bash
./scripts/rollback.sh            # → previous tag
./scripts/rollback.sh <git-sha>  # → a specific known-good tag
```

---

## One-time cutover: bind-mount → image  (DELIBERATE, low-traffic window)

The box currently runs bind-mounted source. Cut over once:

1. **Auth the host to GHCR**: `echo $GHCR_PAT | docker login ghcr.io -u <user> --password-stdin`.
2. Ensure `build-core-image.yml` has run green at least once (a `:latest` + `:<sha>` exists).
3. **Align the registry name**: either keep `ghcr.io/<owner>/hivemind-core` (set `IMAGE=` in
   the scripts / Coolify) OR retag to whatever the Coolify compose expects
   (`docker-compose.coolify.yml` uses `hivemind/core-api:${VERSION}` — point VERSION at the sha
   and mirror the image name, or change the compose `image:` to the GHCR ref).
4. Deploy the current sha: `IMAGE_TAG=<sha> ./scripts/deploy-image.sh`. Verify `/health` + a
   real `/api/chat` smoke (see `scripts/deploy.sh verify`).
5. Stop pulling source on the box. Future deploys = `deploy-image.sh <sha>` only.

> Coolify users: equivalently set the app's image to the GHCR tag and redeploy with
> `VERSION=<sha>`; keep the same health-gate + rollback discipline.

## Caddy health gate (apply with the cutover)

`Caddyfile.core` now health-polls the upstream (`/health`, 10s) and stops routing to an
unhealthy container. Reload Caddy after updating it. For **blue-green** (NEXT tier): list
both upstreams (`hivemind-api` + `hivemind-api-green`), deploy green, wait for it to pass
health, then remove blue.

## Invariants
- A tag is immutable — never rebuild a sha; build a new commit.
- Never deploy a tag the test gate didn't pass.
- Keep the last ~10 `:<sha>` tags on the host for rollback (`docker image prune` carefully).
- DB migrations MUST be expand/contract — see `docs/MIGRATION_RUNBOOK.md` (a bad migration
  sinks every version at once; the image pipeline does not protect against it).
