# TARA Grok — Production Deployment Runbook

`tara-grok` is a **new sidecar container deployed alongside** the unchanged
`tara-deepgram`. This is the correct shape: it mirrors exactly how the existing
voice adapter runs today. Core stays the canonical owner of identity, config,
skills, tools, memory, call history, billing; the adapter owns only realtime
audio + telephony transport.

Verified live topology this runbook is built on (do not assume — this is what is
actually running):

| Fact | Value (verified) |
|---|---|
| Existing adapter | `tara-deepgram` container, image `hivemind/tara-deepgram:${VERSION}` |
| Its port | published `127.0.0.1:8091:8091` (loopback only) |
| Its route | `core.singulancelabs.com/voice2/*` → `reverse_proxy localhost:8091` |
| Reverse proxy | `hm-caddy`, **`network_mode: host`** → `localhost:<port>` reaches each loopback-published container |
| Live Caddyfile | `/root/hivemind/infra/Caddyfile` → mounted at `/etc/caddy/Caddyfile` |
| Compose file | `/root/hivemind/infra/docker-compose.hetzner.yml` |
| **Build tree (canonical)** | `/root/hivemind-main` @ `singulance-main` |
| Compose/run tree (has `.env`) | `/root/hivemind` |

`tara-grok` slots in at **`127.0.0.1:8092`** with route **`/voice-grok/*`**,
leaving `/voice2` and every existing service byte-for-byte untouched.

---

## 0. Reconcile the release lineage FIRST (blocking)

There are three worktrees and they are **not** interchangeable — building from
the wrong one ships stale or divergent code:

- `/root/hivemind` — `feat/mneme-foundation`, **dirty (111 files)**. This is the
  compose/run dir only (holds `.env`). **Never a build source.**
- `/root/hivemind-main` — `singulance-main`, clean, **HEAD = current release**
  (`699377a88` at time of writing). **← build here.**
- `/root/hivemind-next` — `singulance-main`, clean, but **diverged/behind**
  (`71554f59`). Stale duplicate. Do **not** build from it; reconcile or remove it
  so nobody builds the wrong tree by accident.

Pin the build tree explicitly every time:

```bash
BUILD_TREE=/root/hivemind-main
git -C "$BUILD_TREE" fetch origin
git -C "$BUILD_TREE" status --porcelain        # MUST be empty
git -C "$BUILD_TREE" rev-parse --short HEAD     # record this SHA = the release
```

`services/tara-grok` source lives in **`$BUILD_TREE/services/tara-grok`** — the
compose `build.context` is relative to the CWD you build from, so building from
`$BUILD_TREE` is what makes the image contain the intended code.

---

## 1. Compose service (mirror tara-deepgram + spec hardening)

Add to `infra/docker-compose.hetzner.yml` beside `tara-deepgram`. It is a **new
key** — adding it cannot recreate or downgrade any existing service.

```yaml
  tara-grok:
    build: { context: ../services/tara-grok }
    image: hivemind/tara-grok:${VERSION:-latest}
    container_name: tara-grok
    restart: unless-stopped
    mem_limit: 768m
    memswap_limit: 1152m
    cpus: 0.75
    env_file:
      - ${TARA_GROK_ENV_FILE:-/opt/tara-grok/.env}
    environment:
      HIVEMIND_CORE_EVENTS_URL: http://core:3000/internal/v1/tara/calls
    ports:
      - "127.0.0.1:${TARA_GROK_PORT:-8092}:8092"   # loopback only; Caddy fronts it
    depends_on:
      core: { condition: service_healthy }
    # Spec hardening — adapter holds no durable state, so lock it down:
    read_only: true
    tmpfs: [ /tmp ]
    security_opt: [ "no-new-privileges:true" ]
    cap_drop: [ ALL ]
    user: "10001:10001"                            # non-root
    # NOTE: no transcript/call-log volume (unlike tara-deepgram) — Grok calls
    # persist only via Core /internal/v1/tara/calls/:sessionId/events.
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8092/health/ready', timeout=3)"]
      interval: 15s
      timeout: 5s
      retries: 5
      start_period: 10s
```

`/health/live` = process up; `/health/ready` = config valid + Core reachable +
xAI credentials present, **without consuming paid audio**. The healthcheck uses
`ready`.

---

## 2. Caddy route (add `/voice-grok`, never touch `/voice2`)

Edit `/root/hivemind/infra/Caddyfile`, inside the existing
`core.singulancelabs.com { … }` block, **above** the catch-all
`reverse_proxy localhost:2026`:

```caddyfile
core.singulancelabs.com {
	handle /voice2/* {                 # UNCHANGED — Deepgram
		uri strip_prefix /voice2
		reverse_proxy localhost:8091
	}
	handle /voice-grok/* {             # NEW — Grok
		uri strip_prefix /voice-grok
		reverse_proxy localhost:8092
	}
	reverse_proxy localhost:2026       # catch-all → core
}
```

Validate before reload — a bad Caddyfile must never take voice2 down:

```bash
docker exec hm-caddy caddy validate --config /etc/caddy/Caddyfile
docker exec hm-caddy caddy reload   --config /etc/caddy/Caddyfile   # graceful, zero-drop
```

---

## 3. Secrets (`/opt/tara-grok/.env`, root-owned, 0600)

Keep xAI keys, MCP auth headers, and encryption keys **out of** compose and out
of Core config JSON. Production requires them present — **no dev fallback**:

```
XAI_API_KEY=...
XAI_REALTIME_URL=wss://api.x.ai/...           # server-side registry value, never client-supplied
TARA_GROK_MODEL=grok-voice-think-fast-1.0     # pinned
TARA_GROK_SERVICE_TOKEN=...                    # scoped only to Core session/event/tool mediation
# Telnyx signing + any MCP tool-profile secrets
```

`TARA_GROK_CAPABILITY_SECRET` belongs to Core's environment only. Core signs
the short-lived browser capability and atomically consumes it; `tara-grok` does
not need, receive, or validate the signing secret. Never inject the general
`HIVEMIND_MASTER_API_KEY` into this adapter.

---

## 4. Build + deploy — ONLY tara-grok, guarded

The hazard in a shared-`VERSION` compose file: every service is
`image: …:${VERSION:-latest}`, so a bare `up` (no `--no-deps`, or no service
name) reconciles the **whole stack** to the new tag — recreating or downgrading
live services. The safe, single-service pattern (same one used for the
control-plane deploy) plus a **dry-run assertion** that nothing else changes:

```bash
REL_SHA=$(git -C /root/hivemind-main rev-parse --short HEAD)
TAG="prod-$(date +%Y%m%d)-${REL_SHA}"          # immutable, revision-tagged

# BUILD from the canonical clean tree
cd /root/hivemind-main
VERSION="$TAG" docker compose --env-file /root/hivemind/.env \
  -f infra/docker-compose.hetzner.yml build tara-grok

# GUARD: prove the deploy would create ONLY tara-grok, recreate/downgrade nothing
cd /root/hivemind
VERSION="$TAG" docker compose --env-file /root/hivemind/.env \
  -f infra/docker-compose.hetzner.yml up -d --no-deps --dry-run tara-grok
#  ^ read the plan: it must show tara-grok Created and NO other service
#    Recreate/Start/Recreated. If it lists any other container → ABORT.

# DEPLOY (only after the dry-run is clean)
VERSION="$TAG" docker compose --env-file /root/hivemind/.env \
  -f infra/docker-compose.hetzner.yml up -d --no-deps tara-grok
```

Why this is safe: naming a single service + `--no-deps` makes compose act on
`tara-grok` alone; `depends_on: core` is skipped (core already runs healthy).
Other containers keep their current image/tag — compose does not stop or
recreate services you didn't name.

---

## 5. Verify (loopback → public), before any traffic

```bash
# 5a. container health, no paid audio
docker exec tara-grok python -c "import urllib.request;print(urllib.request.urlopen('http://localhost:8092/health/live',timeout=3).read())"
docker exec tara-grok python -c "import urllib.request;print(urllib.request.urlopen('http://localhost:8092/health/ready',timeout=3).read())"

# 5b. host loopback (Caddy target)
curl -sf http://127.0.0.1:8092/health/ready && echo OK

# 5c. public route, /voice2 still intact
curl -sf https://core.singulancelabs.com/voice-grok/health/ready && echo GROK-OK
curl -sfI https://core.singulancelabs.com/voice2/ | head -1        # Deepgram untouched

docker logs tara-grok --since 60s | tail -20                       # clean boot, no secret leak
```

---

## 6. Canary order

`Deepgram stays the default.` Advance a gate only when the prior one is green:

1. Core schema + security (RBAC, capabilities, webhook verify) — Core deploy, not this container.
2. `tara-grok` loopback (§5a/5b).
3. Public `/voice-grok` (§5c).
4. Internal org (flip its `TaraRuntimeConfig.defaultProvider = grok`).
5. Selected tenants.
6. General availability.

Changing the org toggle only affects **new** sessions/calls — active or queued
calls keep their snapshotted provider and are never redialed.

---

## 7. Rollback (removes ONLY Grok)

```bash
# 1. Core: disable new Grok sessions (org toggle / provider registry) and let
#    existing Grok sessions drain. Restore Deepgram as default.
# 2. Remove the Grok route, keep /voice2:
#    edit infra/Caddyfile → delete the /voice-grok handle block
docker exec hm-caddy caddy validate --config /etc/caddy/Caddyfile
docker exec hm-caddy caddy reload   --config /etc/caddy/Caddyfile
# 3. Remove only the container (never `compose down` — that stops the stack):
docker rm -f tara-grok
```

No existing service is touched at any step. If a prior `tara-grok` image tag
existed, roll forward/back by re-running §4 with that immutable `$TAG`.

---

## Billing note

xAI `$0.05 / audio minute` is **audio-duration** billing, not guaranteed
wall-clock `$3/hour`. Meter billable text messages and paid server-side tools
(web/X/Collections — default **off**) separately. HIVEMIND recall stays the
preferred, in-house knowledge source.

---

## 8. Durability — why this survives git overwrites and deploy scripts

`tara-grok` is a first-class core service. Everything needed to recreate it is
now **versioned or on disk outside git**, not held in a session:

| Asset | Where | Protected by |
|---|---|---|
| `tara-grok` service definition | `infra/docker-compose.hetzner.yml` in **both** trees | committed (run-tree `a0531ccb3`, canonical `c275821a6`) |
| `/voice-grok` route | `infra/Caddyfile` (run tree) | **now tracked** — it was UNTRACKED, a `git clean -fd` would have deleted the live proxy config |
| Adapter secrets | `/opt/tara-grok/.env` (0600 root) | outside git by design; back up with the box |
| Core↔adapter pairing | `/root/hivemind/.env` + `/opt/tara-grok/core-pairing.env` | gitignored; `.env.bak-pre-taragrok-*` snapshot kept |
| DB schema | `hivemind.tara_runtime_configs` / `tara_voice_sessions` / `tara_provider_events` | applied + recorded in `_prisma_migrations` |
| Restart survival | `restart: unless-stopped` + healthcheck | verified by an actual restart test |

**The two compose files are now functionally identical** (comments aside), so a
deploy from `hivemind-main` OR the run tree yields the same result. Previously
`hivemind-main` would have re-exposed `tara-deepgram` on all interfaces and
dropped `NANGO_ENCRYPTION_KEY`.

### NEVER run `prisma migrate deploy` on this database
The migration history is **abandoned**: 34 migrations are recorded applied, 77
show "pending", and one (`20260518230000_connector_webhooks`) is recorded
**failed** — yet the objects those "pending" migrations create already exist
(`hyper_rooms`, `tara_calls`, `tara_campaigns`). The schema is managed by
`db push` / direct idempotent DDL. `migrate deploy` would refuse (failed
migration) or try to replay 77 migrations against a schema already ahead of
them. Core logs `Error: P3005` at boot for this reason — known and non-fatal.

**Apply new schema like this instead** (idempotent DDL, single transaction):
```bash
cat core/prisma/migrations/<name>/migration.sql \
 | docker exec -i hm-postgres psql -U hivemind_user -d hivemind -v ON_ERROR_STOP=1 --single-transaction
```
Then record it so nothing replays it later:
```sql
INSERT INTO public._prisma_migrations (id, checksum, migration_name, started_at, finished_at, applied_steps_count)
VALUES (gen_random_uuid()::text, 'manual-idempotent-apply', '<name>', now(), now(), 1) ON CONFLICT DO NOTHING;
```
**Pre-flight any new UNIQUE index against live data first.** This deploy would
have failed on `CREATE UNIQUE INDEX tara_turns_call_id_seq_key` — one call had
two `seq=1` turns (a duplicated greeting). Fixed non-destructively by
renumbering the later row, not deleting it.

### Rollback pins
- core → `/root/hivemind/.last-core-taragrok-rollback` (`prod-20260724-f0ad0f9fc`)
- compose/Caddy → `infra/*.bak-pre-taragrok-*`
- `.env` → `.env.bak-pre-taragrok-*`
