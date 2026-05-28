# HA Replica Playbook (hm-core)

Single-instance hm-core is the current default. Switch to 2 replicas for
enterprise GA. Code is replica-safe today (Redis-backed rate limit kicks
in automatically when `REDIS_HOST` is set, governance cycle row-lock is
pool-safe).

## What needs to happen

1. **Coolify panel** → service `app` (hm-core) → scale to 2 replicas.
   Coolify spawns `app-1` and `app-2` containers on the same host.
2. **Update Caddy** at `/opt/HIVEMIND/Caddyfile` to load-balance:
   ```
   https://core.hivemind.davinciai.eu:443 {
       reverse_proxy hm-core-1:3000 hm-core-2:3000 {
           lb_policy least_conn
           health_uri /health
           health_interval 10s
           health_timeout 3s
           health_status 2xx
           fail_duration 30s
           max_fails 3
       }
       tls /etc/letsencrypt/live/core.hivemind.davinciai.eu/fullchain.pem /etc/letsencrypt/live/core.hivemind.davinciai.eu/privkey.pem
   }
   ```
   Reload: `docker exec hivemind-caddy caddy reload --config /etc/caddy/Caddyfile`.
3. **Drain test**: kill one replica, watch the other absorb traffic.
   ```bash
   ssh myserver "docker stop hm-core-1 && for i in 1 2 3 4 5; do curl -sS https://core.hivemind.davinciai.eu/health -w 'HTTP %{http_code}\n' -o /dev/null; done"
   ```
   Expect 5/5 HTTP 200 (served by hm-core-2).

## Already replica-safe

- **Rate limit**: `middleware/rate-limit.js` auto-detects Redis when
  `REDIS_HOST` is set; both replicas share the same counter window.
- **Governance cycle**: row-level `circuit_breaker_until` UPDATE prevents
  two replicas from running the same cycle at once.
- **Stateless HTTP**: no session affinity required.
- **Prisma pool**: per-replica pool, sized at `PRISMA_CONNECTION_LIMIT=50`.
  Confirm Postgres `max_connections` ≥ 200 (currently set).

## Not yet replica-safe

- **Faraday token counter** (`globalThis.__faradayLastTokens`) is per-process.
  Acceptable: each replica reports its own usage; daily roll-up is
  approximate. Move to a Redis INCR for exact accounting if needed.
- **In-flight schedule jitter**: each replica jitters 0-60s on start
  + holds `circuit_breaker_until` row-lock so concurrent cycles are
  prevented, but both replicas may attempt the lock back-to-back —
  loser returns `skipped_lock_busy` (correct behavior).
