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
  log "generating .env (secrets + storage for this arch)…"
  MNEME_ORGS_DEFAULT=""   # hybrid by default; set to "*" or an orgId to use .amr (x86 only)
  cat > "$ENV_FILE" <<EOF
# ── generated secrets ──
POSTGRES_USER=hivemind_user
POSTGRES_PASSWORD=$(gen 24)
POSTGRES_DB=hivemind
REDIS_PASSWORD=$(gen 24)
QDRANT_API_KEY=$(gen 24)
SESSION_SECRET=$(gen 32)
HIVEMIND_ADMIN_SECRET=$(gen 32)
HIVEMIND_MASTER_API_KEY=hm_master_$(gen 24)
NANGO_SECRET_KEY=$(gen 24)
# ── storage (arch=$ARCH) ──
MNEME_ORGS=$MNEME_ORGS_DEFAULT
MNEME_MODE=dual
MNEME_DATA_ROOT=/app/data/mneme
MNEME_BINDING=/app/src/vector/mneme/singulance-amr.linux-$([ "$ARCH" = arm64 ] && echo arm64 || echo x64)-gnu.node
# ── domain (set to enable Caddy auto-TLS for all subdomains) ──
DOMAIN=
# ── model providers — FILL THESE ──
GROQ_API_KEY=
OPENROUTER_API_KEY=
OPENAI_API_KEY=
MISTRAL_API_KEY=
ANTHROPIC_API_KEY=
VERSION=latest
EOF
  warn ".env written. Fill GROQ_API_KEY + OPENROUTER_API_KEY (and DOMAIN if you have one). See infra/ENV-REFERENCE.txt for every key. Then re-run."
  exit 0
fi
set -a; . "$ENV_FILE"; set +a
grep -qE '^GROQ_API_KEY=.+' "$ENV_FILE" || die "GROQ_API_KEY empty in .env — fill it, re-run"
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
if [ -n "${DOMAIN:-}" ]; then
  log "configuring Caddy for $DOMAIN + subdomains (auto-TLS)…"
  CADDY="$ROOT/infra/Caddyfile"
  cat > "$CADDY" <<EOF
# auto-HTTPS for all HIVEMIND subdomains. Point DNS A-records (or *.$DOMAIN) at this server's IP.
core.$DOMAIN  { reverse_proxy localhost:${CORE_PORT:-2026} }
api.$DOMAIN   { reverse_proxy localhost:${CONTROL_PORT:-2027} }
nango.$DOMAIN { reverse_proxy localhost:${NANGO_PORT:-3003} }
EOF
  docker rm -f hm-caddy >/dev/null 2>&1 || true
  docker run -d --name hm-caddy --restart unless-stopped --network host \
    -v "$CADDY":/etc/caddy/Caddyfile -v hm-caddy-data:/data caddy:latest >/dev/null
  log "Caddy up. DNS needed (A-records → THIS server IP): core.$DOMAIN  api.$DOMAIN  nango.$DOMAIN  (or *.$DOMAIN)."
  log "Then point the dashboard's REACT_APP_CONTROL_PLANE_URL at https://api.$DOMAIN."
else
  warn "no DOMAIN set — engine on ports core:${CORE_PORT:-2026} control:${CONTROL_PORT:-2027}. Set DOMAIN in .env + re-run for TLS subdomains."
fi

log "✅ HIVEMIND engine up on $OS/$ARCH."
[ -n "${MNEME_ORGS:-}" ] && log "BACK UP the hivemind-data volume (holds .amr)."
log "Full services (tara/hermes/playwright): $COMPOSE --profile full up -d --build"
