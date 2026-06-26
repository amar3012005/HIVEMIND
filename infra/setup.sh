#!/usr/bin/env bash
# HIVEMIND engine — complete, adaptable bring-up for a FRESH server. Detects the machine, installs every
# prerequisite, generates config, builds + starts the full engine, runs migrations, and (if you give a
# domain) sets up Caddy with auto-TLS so all subdomains work. Idempotent — safe to re-run.
#   git clone --branch infra --single-branch <repo> hivemind && cd hivemind && sudo ./infra/setup.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE_FILE="$ROOT/infra/docker-compose.hetzner.yml"
ENV_FILE="$ROOT/.env"
log(){ printf '\033[1;36m[hivemind]\033[0m %s\n' "$*"; }
warn(){ printf '\033[1;33m[hivemind] %s\033[0m\n' "$*"; }
die(){ printf '\033[1;31m[hivemind] %s\033[0m\n' "$*" >&2; exit 1; }
gen(){ openssl rand -hex "${1:-32}"; }

# ── 0. detect machine ───────────────────────────────────────────────────────
ARCH="$(uname -m)"; OS="$(uname -s)"
case "$ARCH" in
  x86_64|amd64)  ARCH=amd64; AMR_OK=1 ;;     # linux-x64 .amr binding present
  aarch64|arm64) ARCH=arm64; AMR_OK=0 ;;     # .amr needs an arm64 binding; default hybrid
  *) die "unsupported arch: $ARCH" ;;
esac
[ "$OS" = "Linux" ] || die "this installer targets Linux servers (found $OS). For local dev use Docker Desktop + the compose directly."
PKG=""; command -v apt-get >/dev/null && PKG=apt; command -v dnf >/dev/null && PKG=dnf; command -v yum >/dev/null && PKG=${PKG:-yum}
[ -n "$PKG" ] || die "no supported package manager (apt/dnf/yum)"
log "machine: $OS/$ARCH · pkg: $PKG · .amr supported: $([ "$AMR_OK" = 1 ] && echo yes || echo 'no (hybrid)')"

# ── 1. install prerequisites ────────────────────────────────────────────────
pkg_install(){ case "$PKG" in
  apt) export DEBIAN_FRONTEND=noninteractive; apt-get update -qq; apt-get install -y -qq "$@" ;;
  dnf) dnf install -y -q "$@" ;; yum) yum install -y -q "$@" ;; esac; }
need(){ command -v "$1" >/dev/null 2>&1; }
log "installing base packages…"
need curl || pkg_install curl; need openssl || pkg_install openssl; need git || pkg_install git
need jq || pkg_install jq || true
if ! need docker; then
  log "installing Docker…"; curl -fsSL https://get.docker.com | sh; systemctl enable --now docker 2>/dev/null || true
fi
docker compose version >/dev/null 2>&1 || pkg_install docker-compose-plugin || die "install the docker compose v2 plugin"
need docker || die "docker install failed"

# ── 2. env (secrets + arch-aware storage) ───────────────────────────────────
if [ ! -f "$ENV_FILE" ]; then
  [ -t 0 ] || die "no .env and not a TTY — run interactively, or pre-create .env from infra/prod-defaults.conf"
  DEFAULTS="$ROOT/infra/prod-defaults.conf"; [ -f "$DEFAULTS" ] || die "missing infra/prod-defaults.conf"
  log "Interactive setup. Everything else inherits the production config from infra/prod-defaults.conf —"
  log "you only enter the domain + the sensitive provider keys. Press Enter to accept a [default]."
  ask(){  local v; read -rp "  $1${2:+ [$2]}: " v </dev/tty; printf '%s' "${v:-$2}"; }
  asks(){ local v; read -rsp "  $1: " v </dev/tty; printf '\n' >/dev/tty; printf '%s' "$v"; }
  echo ""
  DOMAIN_IN="$(ask 'Domain (e.g. singulancelabs.com; blank = ports only, no TLS)' '')"
  FE_MODE_IN="$(ask 'Frontend — vercel (external, e.g. Cloudflare/Vercel) or container' 'vercel')"
  echo "  — provider keys (sensitive; input hidden) —"
  GROQ_IN="$(asks 'GROQ_API_KEY (required)')"
  OR_IN="$(asks 'OPENROUTER_API_KEY (required)')"
  OPENAI_IN="$(asks 'OPENAI_API_KEY (optional, Enter to skip)')"
  ANTHROPIC_IN="$(asks 'ANTHROPIC_API_KEY (optional)')"
  MISTRAL_IN="$(asks 'MISTRAL_API_KEY (optional)')"
  CARTESIA_IN="$(asks 'CARTESIA_API_KEY (optional — Tara voice)')"
  [ -n "$GROQ_IN" ] || die "GROQ_API_KEY is required"
  CORS=""; [ -n "$DOMAIN_IN" ] && CORS="https://$DOMAIN_IN,https://www.$DOMAIN_IN"
  BIND="/app/src/vector/mneme/singulance-amr.linux-$([ "$ARCH" = arm64 ] && echo arm64 || echo x64)-gnu.node"
  log "writing .env (prod defaults + your answers + generated secrets)…"
  {
    cat "$DEFAULTS"
    echo ""
    echo "# ── generated secrets + your answers (override the blanks above) ──"
    echo "POSTGRES_USER=hivemind_user"; echo "POSTGRES_PASSWORD=$(gen 24)"; echo "POSTGRES_DB=hivemind"
    echo "REDIS_PASSWORD=$(gen 24)"; echo "QDRANT_API_KEY=$(gen 24)"
    echo "SESSION_SECRET=$(gen 32)"; echo "HIVEMIND_ADMIN_SECRET=$(gen 32)"
    echo "HIVEMIND_MASTER_API_KEY=hm_master_$(gen 24)"; echo "NANGO_SECRET_KEY=$(gen 24)"
    echo "MNEME_ORGS="; echo "MNEME_MODE=dual"; echo "MNEME_DATA_ROOT=/app/data/mneme"; echo "MNEME_BINDING=$BIND"
    echo "DOMAIN=$DOMAIN_IN"; echo "FE_MODE=$FE_MODE_IN"; echo "HIVEMIND_ALLOWED_ORIGINS=$CORS"
    echo "GROQ_API_KEY=$GROQ_IN"; echo "OPENROUTER_API_KEY=$OR_IN"
    [ -n "$OPENAI_IN" ]    && echo "OPENAI_API_KEY=$OPENAI_IN"
    [ -n "$ANTHROPIC_IN" ] && echo "ANTHROPIC_API_KEY=$ANTHROPIC_IN"
    [ -n "$MISTRAL_IN" ]   && echo "MISTRAL_API_KEY=$MISTRAL_IN"
    [ -n "$CARTESIA_IN" ]  && echo "CARTESIA_API_KEY=$CARTESIA_IN"
    echo "VERSION=latest"
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  log ".env written. Continuing to build — no re-run needed."
fi
# safe load: read KEY=VALUE literally (values may contain spaces/prose — never execute them)
set -a
while IFS= read -r _line; do
  case "$_line" in ''|\#*) continue ;; *=*) export "${_line%%=*}=${_line#*=}" ;; esac
done < "$ENV_FILE"
set +a
grep -qE '^GROQ_API_KEY=.+' "$ENV_FILE" || die "GROQ_API_KEY empty — delete .env and re-run to re-enter"
if [ -n "${MNEME_ORGS:-}" ] && [ "$ARCH" = arm64 ] && [ "$AMR_OK" = 0 ]; then
  warn "MNEME_ORGS set on arm64 but no arm64 .amr binding — falling back to HYBRID (unset MNEME_ORGS)."
  warn "build the arm binding with infra/build-amr-arm64.sh to enable .amr on arm."
fi

# ── 3. build + start ────────────────────────────────────────────────────────
COMPOSE="docker compose -f $COMPOSE_FILE --env-file $ENV_FILE"
log "building + starting the engine (this pulls images + compiles — first run is slow)…"
$COMPOSE up -d --build

log "waiting for postgres…"; for i in $(seq 1 40); do $COMPOSE exec -T postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1 && break; [ "$i" = 40 ] && die "postgres unhealthy — $COMPOSE logs postgres"; sleep 3; done
log "applying schema…"; $COMPOSE exec -T core npx prisma migrate deploy 2>/dev/null || $COMPOSE exec -T core npx prisma db push --skip-generate 2>/dev/null || warn "run prisma migrate manually in hm-core"
log "waiting for core /health…"; for i in $(seq 1 40); do $COMPOSE exec -T core node -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null && break; [ "$i" = 40 ] && die "core unhealthy — $COMPOSE logs core"; sleep 3; done

# ── 4. domain + subdomains (Caddy auto-TLS) ─────────────────────────────────
FE_MODE="${FE_MODE:-vercel}"
if [ -n "${DOMAIN:-}" ]; then
  log "configuring Caddy for $DOMAIN + subdomains (auto-TLS)…"
  CADDY="$ROOT/infra/Caddyfile"
  cat > "$CADDY" <<EOF
# auto-HTTPS for all HIVEMIND subdomains. Point DNS A-records (or *.$DOMAIN) at this server's IP.
core.$DOMAIN  { reverse_proxy localhost:${CORE_PORT:-2026} }
api.$DOMAIN   { reverse_proxy localhost:${CONTROL_PORT:-2027} }
nango.$DOMAIN { reverse_proxy localhost:${NANGO_PORT:-3003} }
EOF
  # FE: container mode serves the dashboard at the root domain; vercel mode leaves the root to Vercel.
  if [ "$FE_MODE" = "container" ]; then
    log "building + serving the dashboard (container) at $DOMAIN…"
    docker build -t hivemind/fe:${VERSION:-latest} \
      --build-arg REACT_APP_CONTROL_PLANE_URL="https://api.$DOMAIN" \
      --build-arg REACT_APP_CORE_API_URL="https://core.$DOMAIN" \
      "$ROOT/frontend/Da-vinci"
    docker rm -f hm-fe >/dev/null 2>&1 || true
    docker run -d --name hm-fe --restart unless-stopped -p ${FE_PORT:-8088}:80 hivemind/fe:${VERSION:-latest}
    echo "$DOMAIN { reverse_proxy localhost:${FE_PORT:-8088} }" >> "$CADDY"
    echo "www.$DOMAIN { redir https://$DOMAIN{uri} }" >> "$CADDY"
  fi
  docker rm -f hm-caddy >/dev/null 2>&1 || true
  docker run -d --name hm-caddy --restart unless-stopped --network host \
    -v "$CADDY":/etc/caddy/Caddyfile -v hm-caddy-data:/data caddy:latest >/dev/null
  log "Caddy up. DNS (A-records → THIS server IP): core.$DOMAIN  api.$DOMAIN  nango.$DOMAIN $([ "$FE_MODE" = container ] && echo "$DOMAIN") (or *.$DOMAIN)."
  if [ "$FE_MODE" = "vercel" ]; then
    cat <<FEV

  ── FE is on VERCEL ── set these in your Vercel project (Settings → Environment Variables), then redeploy:
       REACT_APP_CONTROL_PLANE_URL = https://api.$DOMAIN
       REACT_APP_CORE_API_URL      = https://core.$DOMAIN
     Point your Vercel domain (the dashboard) wherever you like; it talks to THIS engine via the URLs above.
FEV
  else
    log "Dashboard served at https://$DOMAIN (container)."
  fi
else
  warn "no DOMAIN set — engine on ports core:${CORE_PORT:-2026} control:${CONTROL_PORT:-2027}. Set DOMAIN in .env + re-run for TLS subdomains."
  [ "$FE_MODE" = vercel ] && warn "FE (Vercel): set REACT_APP_CONTROL_PLANE_URL to your control-plane URL once you have a domain."
fi

log "✅ HIVEMIND engine up on $OS/$ARCH."
[ -n "${MNEME_ORGS:-}" ] && log "BACK UP the hivemind-data volume (holds .amr)."
log "Full services (tara/hermes/playwright): $COMPOSE --profile full up -d --build"
