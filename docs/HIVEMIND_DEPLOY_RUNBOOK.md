# HIVEMIND — Feature Build + Clean Deploy Runbook

> **SUPERSEDED FOR PRODUCTION DEPLOYMENT.** Use
> [`PRODUCTION_RELEASE_PROTOCOL.md`](./PRODUCTION_RELEASE_PROTOCOL.md) and
> [`PRODUCTION_RELEASE.md`](./PRODUCTION_RELEASE.md). Commands below are retained
> as historical implementation context and must not be executed against SINGULANCE
> when they use mutable tags, shared checkouts, `scp`, or retired replicas.

How any session should build a feature and ship it so it is **durable** (survives a
container recreate) and **safe** (default-off, tested, no regression). Grounded in the
real topology — verified 2026-07-13.

---

## 0. Topology you must know first

| Box (ssh alias) | What it is | Key bits |
|---|---|---|
| `singulance` | Production SINGULANCE engine for `*.singulancelabs.com` | compose project `hivemind`, file `/root/hivemind/infra/docker-compose.hetzner.yml`; vNext frontend compose file `/root/hivemind-next/infra/docker-compose.next.yml` |

Do not deploy SINGULANCE production changes to `myserver`. It is not part of
the current production release path. BYOD customer agents are separate remote
data planes and are upgraded through their authenticated agent release process,
not by treating another central box as production.

- **Core**: image `hivemind/core-api:latest`, compose service `core` (container `hm-core`),
  `build: { context: .., dockerfile: Dockerfile.production }`, `env_file: [../.env]`
  (= `/root/hivemind/.env`). **Single replica** (hm-core-2 retired). `hm-core.service`
  systemd is **inactive/vestigial** — compose is authoritative.
- **Core code is BAKED into the image** (running container only mounts `/app/data` +
  `/app/logs` volumes — NO src bind-mount). → **code changes require an image REBUILD**,
  not just a restart/pull.
- **Control-plane**: compose service `control-plane` (container `hm-control`), internal
  port 3000, loopback port 2027, publicly routed through
  `https://api.singulancelabs.com`.
- **Frontend**: separate repo `frontend/Da-vinci`; deploy the exact committed SHA
  with `scripts/deploy-singulance-home.sh <sha>`. It builds in an isolated clone,
  smoke-tests the candidate, tags the prior image `hivemind/fe:stable-single`,
  tags the candidate `hivemind/fe:latest-single`, and recreates only
  `hivemind-next-frontend-1` on loopback port 2388.
- **Remote-org memory** lives on each customer's authenticated BYOD agent. Managed
  organization memory lives in `singulance` PostgreSQL schema `hivemind`, with
  Qdrant as rebuildable retrieval acceleration.

### Image channels

Every running production service keeps two named channels:

- `latest`: the currently deployed, health-gated candidate.
- `stable`: the immediately previous known-good image retained for rollback.

For the vNext frontend the channel names are `latest-single` and
`stable-single`. Before replacing `latest`, tag its current digest as `stable`;
never move `stable` after a failed health or feature gate. Commit-specific and
timestamped rollback tags may be retained in addition to these two channels.

---

## 1. Build behind a flag (default OFF)

- Gate every new behavior on an **env flag** (`FOO_ENABLED`) AND/OR a **per-request field**
  (`body.foo`). Per-request lets you A/B on prod without flipping the global default.
- Default unset → old path byte-identical. New code is dormant until opted in.
- Reuse existing building blocks (don't fork the pipeline). Match the existing
  return/`{plan,usage}` contract so downstream is untouched.

## 2. Test SAFELY on the box (before any flip)

Call the live endpoint with the **master key** + per-request flag, against a **real org**:
```bash
ssh singulance "docker exec -i hm-core node --input-type=module <<'PY'
const MK=process.env.HIVEMIND_MASTER_API_KEY;
const H={'Authorization':'Bearer '+MK,'x-hm-org-id':'<ORG_UUID>','x-hm-user-id':'<USER_UUID>','Content-Type':'application/json'};
// body.<flag>:'...' opts THIS request in — prod default untouched
const r=await fetch('http://localhost:3000/api/<route>',{method:'POST',headers:H,body:JSON.stringify({...,'<flag>':'...'})});
console.log(await r.text());
PY"
```
- A/B new vs old on the **same** inputs: accuracy parity, token/latency delta, **regressions**.
- **Run the safety gates** specific to the change. (Example that bit us: a /chat router that
  replaced the planner silently dropped **auto-save** — always test the side-paths, not just
  the happy path.)
- Use real data, not toy inputs. Clean up any test memories you inject.

## 3. Deploy DURABLY

`docker cp` hot-patching the running container is **ephemeral** — a recreate reverts to the
stale image. Ship a real image instead.

### PREFERRED (2026-07-03): off-box CI build + pull (no build cache on the engine)

On-box `docker compose build` piled up **193GB of build cache** on the engine box. The engine
must NOT be a build box. Pipeline (all wired + verified):

```
git push origin feat/mneme-foundation        # or main
  → CI 'build-core-image' (.github/workflows/build-image.yml) runs the test gate,
    builds Dockerfile.production, pushes ghcr.io/amar3012005/hivemind-core:<sha> (+ :latest)
  → on the engine box:  IMAGE_TAG=<sha> scripts/deploy-image.sh
    (pulls the immutable tag, health-gates it in an EPHEMERAL container FIRST,
     swaps each replica with auto-revert, records previous-tag for rollback)
```

- CI triggers on `main` + `feat/mneme-foundation`, paths `core/**` / `Dockerfile.production` / the workflow file.
- ghcr package is **public** → the box pulls with no auth.
- Get the built sha: `gh run view <run-id> --json headSha -q .headSha`.
- Rollback: `scripts/rollback.sh` (uses the recorded previous-tag).

### FALLBACK — build from box source (only if CI is unavailable)

```bash
# a. land code in git
git add -A && git commit -m "feat: ..."   # Co-Authored-By line per repo rule
git push origin <branch>

# b. sync box build-source (context = /root/hivemind). Either git pull on the box,
#    OR cp the changed files into /root/hivemind/core/src/... (what we do today).

# c. REBUILD the image (bakes box source) + recreate the service
ssh singulance "cd /root/hivemind/infra && \
  docker compose -p hivemind -f docker-compose.hetzner.yml --env-file /root/hivemind/.env build core && \
  docker compose -p hivemind -f docker-compose.hetzner.yml --env-file /root/hivemind/.env up -d --no-deps --no-build --force-recreate core"

# d. verify it's baked + healthy
ssh singulance "docker run --rm --entrypoint sh hivemind/core-api:latest -c 'grep -c <sentinel> /app/src/...'; \
  docker exec hm-core sh -lc 'wget -qO- http://localhost:3000/health'"
```
- `--no-deps` = touch only `core`. `--force-recreate` applies new image + new `.env`.
- Same pattern for `control-plane` (service name `control-plane`, NOT `control`).
- FE changes → `make deploy-fe` (separate path).

## 4. Env / secret changes are durable in `.env`

- Edit `/root/hivemind/.env` (backup first: `cp .env .env.bak.<reason>`), then **recreate** the
  service (restart does NOT re-read env_file — recreate does). `.env` survives recreate.
- Never echo secrets to logs. Pipe via stdin, not command args.
- Flip a finished feature on by setting its flag in `.env` + recreate.

## 5. Registry / seed data — DON'T rely on baked data files

- `core/data/mcp-connectors.json` (and similar) is **shadowed by the `hivemind-data`
  named volume** at `/app/data` — Docker only seeds a volume on first creation, so the
  baked file never reaches a live volume. → seed via **code** (`catalog-seed.js`), which
  upserts on every boot, not by editing the data file.

## 6. Verify like it can't be faked

- Health 200 + the **actual feature** exercised end-to-end (real request, real org).
- Regression check the paths you didn't change.
- For LLM features on `singulance`: it is **OpenRouter-primary** (Groq billing-blocked) —
  every LLM call replays via `groq-fallback.js`; avoid Groq-only params
  (`parallel_tool_calls`, `max_completion_tokens`) under `require_parameters`.

## 7. Recurring gotchas (the landmines)

- **Hot-patch ≠ deployed.** Rebuild the image or it's gone on recreate.
- **`restart` ≠ pick up code or env.** Code = rebuild; env = recreate.
- Compose service is **`control-plane`**, not `control`.
- Named **volume shadows baked files** (registry, etc.).
- **OpenRouter-primary** on self-host → param-strip Groq-only fields.
- Connector OAuth uses the **central Nango** (`api.hivemind.davinciai.eu:8042`); provider
  apps trust only that callback. Self-host points its public Nango there; only `NANGO_URL`
  (server-side mint) must match.
- Two repos: core (this) + `frontend/Da-vinci` (separate git, `make deploy-fe`).

## 8. Coordinate (multi-session)

- Use `claude-peers` `set_summary` + `list_peers` to see who else is on the box.
- Don't recreate `hm-core` while another session is mid-test on it.
- Land in git before rebuilding so others can pull your source.
