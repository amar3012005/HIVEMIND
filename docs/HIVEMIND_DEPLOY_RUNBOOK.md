# HIVEMIND — Feature Build + Clean Deploy Runbook

How any session should build a feature and ship it so it is **durable** (survives a
container recreate) and **safe** (default-off, tested, no regression). Grounded in the
real topology — verified 2026-06-30.

---

## 0. Topology you must know first

| Box (ssh alias) | What it is | Key bits |
|---|---|---|
| `singulance` | self-host deployment (singulancelabs.com) — FULL stack | compose project `hivemind`, file `/root/hivemind/infra/docker-compose.hetzner.yml` |
| `myserver` | managed/davinci deployment (api.hivemind.davinciai.eu) + **central Nango** | byod agent + `hivemind-nango` + dedicated `nango` DB |

- **Core**: image `hivemind/core-api:latest`, compose service `core` (container `hm-core`),
  `build: { context: .., dockerfile: Dockerfile.production }`, `env_file: [../.env]`
  (= `/root/hivemind/.env`). **Single replica** (hm-core-2 retired). `hm-core.service`
  systemd is **inactive/vestigial** — compose is authoritative.
- **Core code is BAKED into the image** (running container only mounts `/app/data` +
  `/app/logs` volumes — NO src bind-mount). → **code changes require an image REBUILD**,
  not just a restart/pull.
- **Control-plane**: compose service `control-plane` (container `hm-control`), internal
  port 3000, external 8040.
- **Frontend**: separate repo `frontend/Da-vinci` (its own git, branch `main`) →
  `make deploy-fe` → builds + recreates `hm-fe` (port 8088). Baked URLs via Dockerfile ARGs.
- **Remote-org memory** (self-host orgs like b30ead1b) lives on the **byod agent**
  (`myserver` `hm-byod-postgres`, schema `hm`). Central orgs in `singulance` `hm-postgres`
  schema `hivemind`.

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

## 3. Deploy DURABLY (the #1 lesson)

`docker cp` hot-patching the running container is **ephemeral** — a recreate reverts to the
stale image. Durable deploy = **rebuild the image from box source**:

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
