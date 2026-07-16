# DEPLOYMENT — strict rules for Codex (and any AI agent) shipping to production

This is the **fast, safe** deploy flow. It replaces the heavy immutable-release
dance for day-to-day shipping. The old protocol (`../docs/PRODUCTION_RELEASE_PROTOCOL.md`)
still describes the invariants; this file is the *operational* procedure.

**Production is one box:** `ssh singulance`. Never deploy anywhere else.

---

## The model (memorize this)

- **ONE deploy branch: `singulance-main`.** You push to it from your laptop; the
  box pulls it. No feature-branch → PR → merge dance for deploys. (Keep code
  review on `hivemind-main` if you want; the *deploy* branch is `singulance-main`.)
- **Live always runs the moving `:latest` tag.** `/root/hivemind/.env` has
  `VERSION=latest` / `NEXT_VERSION=latest` — pinned once, never churned.
- **Exactly ONE rollback per service: the `:stable` tag.** Each deploy retags the
  outgoing live image → `:stable` right before replacing it. `:stable` is a
  **saved tag, never a running container.** Only the last-known-good is kept.
- **Only changed services rebuild.** The deploy diffs against the last-deployed
  SHA and rebuilds just those images; the rest are untouched.

## The one command

```bash
# from your laptop: commit + push to the deploy branch
git push origin <your-sha>:singulance-main       # or merge to it, then push

# on the box (FOREGROUND, wait for it):
ssh singulance 'cd /root/hivemind-next && git fetch origin singulance-main -q \
  && git show FETCH_HEAD:scripts/quick-deploy.sh > /root/quick-deploy.sh \
  && chmod +x /root/quick-deploy.sh && bash /root/quick-deploy.sh singulance-main'
```

Rollback a service (one command, instant — no rebuild):

```bash
ssh singulance 'bash /root/quick-deploy.sh --rollback control-plane'   # or core / fe / employees / tara-deepgram
```

---

## STRICT RULES — violating these has broken prod deploys before

1. **NEVER reset the box checkout to `origin/singulance-main`.** This box's
   remote-tracking ref **lags** (`git fetch` updates `FETCH_HEAD` but not
   `refs/remotes/origin/singulance-main`). Resetting to it rebuilds **ancient
   code** while looking successful. Always reset to **`FETCH_HEAD`**. (The
   script does this — do not "fix" it back.)

2. **VERIFY the built image contains your change BEFORE recreating.** A build
   can silently use the wrong tree (dirty box branch, stale ref). Prove it:
   ```bash
   docker run --rm --entrypoint sh hivemind/control-plane:latest -c 'grep -c <your-new-string> /app/src/control-plane-server.js'
   ```
   Zero = you're about to deploy the wrong code. Stop.

3. **NEVER `docker builder prune -a` / nuke all build cache.** It makes every
   build cold (full `npm install`) and slow. Prune only old cache
   (`--filter until=168h`) + dangling images. Warm cache = seconds-fast rebuilds.

4. **Migrations: additive only, `IF NOT EXISTS`, backed up, applied BEFORE code.**
   - Back up first: `docker exec hm-postgres pg_dump -U hivemind_user -d hivemind -Fc -f /tmp/bk.dump` → copy to `/root/backups/hivemind/`.
   - Apply with `psql -v ON_ERROR_STOP=1`. **Never** `prisma migrate dev` / `db push` on prod.
   - Prod has **no `_prisma_migrations` table** — migrations are applied by raw
     SQL. The `P3005` line at core boot is therefore **benign** (migrate-deploy
     bails on the un-baselined schema; the app runs on the existing schema).

5. **An image IS the code.** If code changed, you MUST rebuild that service —
   `docker compose up -d` alone just restarts the same old image. (With warm
   cache this is fast; that's the point of rule 3.)

6. **Run deploys in the FOREGROUND and wait.** Don't fire-and-forget; watch the
   health gate and the acceptance checks.

7. **Don't leave the box's deploy checkout (`/root/hivemind-next`) on your dirty
   feature branch.** A dirty tree makes `git checkout` abort. The script
   force-checks-out (`-f`) to handle this, but don't rely on parking work there.

8. **One session deploys at a time.** Parallel deploys race the shared
   `VERSION=latest` + `:stable` tags. If another agent is mid-deploy, wait.

9. **Health is NOT acceptance.** After recreate, verify the actual change:
   new route returns 401 (not 404/500), FE chunk contains the new marker, zero
   fresh `fatal/panic/OOM` in logs — not just a 200 on `/health`.

---

## What the script does (so you can trust/debug it)

`scripts/quick-deploy.sh` (on the box at `/root/quick-deploy.sh`):
1. `git fetch` → `git checkout -qf -B singulance-main FETCH_HEAD` (correct code, discard drift).
2. Diff vs `/root/.quickdeploy-last-sha` → list changed services (empty marker → rebuild all).
3. Backup + apply any NEW migration folders.
4. Per changed service: retag current `:latest` → `:stable` (rollback), build new `:latest`, recreate with `--no-deps --force-recreate`, health-gate.
5. Public smoke + prune old cache/dangling + record the deployed SHA.

Compose paths: backend services use `/root/hivemind/infra/docker-compose.hetzner.yml`
with `--env-file /root/hivemind/.env`; frontend uses
`/root/hivemind-next/infra/docker-compose.next.yml --profile single`.

## Services + rollback tags

| Service | Container | live tag | rollback tag |
| --- | --- | --- | --- |
| core-api | `hm-core` | `:latest` | `:stable` |
| control-plane | `hm-control` | `:latest` | `:stable` |
| employees | `hm-employees` | `:latest` | `:stable` |
| tara-deepgram | `tara-deepgram` | `:latest` | `:stable` |
| frontend (app) | `hivemind-next-frontend-1` | `:latest-single` | `:stable-single` |

`hm-fe` (legacy marketing root, port 8088) is NOT part of this flow — leave it alone.

## Disk hygiene

The box filled to 96% from accumulated per-SHA `rollback-*`/`prod-*` tags + build
cache. The one-`:stable` model + `until=168h` cache prune keeps it lean. If it
climbs again: delete old dated `prod-*`/`rollback-*` tags (keep running +
`:latest`/`:stable`), then `docker builder prune -f --filter until=168h`.
