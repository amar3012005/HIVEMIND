#!/usr/bin/env bash
# One command: compose cluster + stable SINGULANCE public URL.
set -euo pipefail
cd "$(dirname "$0")"
ENV_FILE="${HIVEMIND_HYPERAGENT_ENV_FILE:-$PWD/.env}"
[[ -f "$ENV_FILE" ]] || { cp env.example "$ENV_FILE"; chmod 600 "$ENV_FILE"; }
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
export HIVE_HARNESS_TICKET_SECRET HIVE_HARNESS_RUNNER_SERVICE_SECRET CLOUDFLARE_TUNNEL_TOKEN
[[ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]] || { echo '[see] CLOUDFLARE_TUNNEL_TOKEN missing in .env' >&2; exit 1; }

PUBLIC="${HARNESS_PUBLIC_URL:-https://harness-see.singulancelabs.com}"
HOST="${PUBLIC#https://}"
mkdir -p data/dsh-home
chmod 777 data/dsh-home || true
mkdir -p "data/fs/org/${HIVEMIND_ORG_ID:-00000000-0000-4000-8000-000000000001}/shared" \
  "data/fs/org/${HIVEMIND_ORG_ID:-00000000-0000-4000-8000-000000000001}/users/${HIVEMIND_USER_ID:-_owner}/workspace"

COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$PWD/docker-compose.cluster.yml")
HIVEMIND_HARNESS_PARENT_ORIGINS="$PUBLIC" HIVEMIND_HARNESS_TRUSTED_HOSTS="$HOST" \
  "${COMPOSE[@]}" up -d postgres redis harness tunnel

for i in $(seq 1 40); do
  curl -fsS --max-time 2 http://127.0.0.1:13080/health >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS --max-time 3 http://127.0.0.1:13080/health >/dev/null || {
  "${COMPOSE[@]}" logs harness --tail 40 >&2
  echo '[see] harness failed to become healthy' >&2
  exit 1
}

code=000
for i in $(seq 1 30); do
  code="$(curl -sS -o /tmp/see-public.html -w '%{http_code}' --max-time 20 "${PUBLIC}/" || echo 000)"
  if [[ "$code" == 200 ]] && grep -q '__ModuleLoader__' /tmp/see-public.html; then
    break
  fi
  sleep 2
done
if [[ "$code" != 200 ]] || ! grep -q '__ModuleLoader__' /tmp/see-public.html; then
  echo "[see] public GET / failed ($code) for $PUBLIC" >&2
  "${COMPOSE[@]}" logs tunnel --tail 20 >&2
  exit 1
fi
printf '%s\n' "$PUBLIC" > "$PWD/public-url.txt"
printf '\n%s\n' "$PUBLIC"
printf 'local: http://localhost:13080/\n'
