#!/usr/bin/env bash
# Safe operator interface for the SINGULANCE production engine.
# Run from any clean HIVEMIND checkout with SSH host alias `singulance`.
set -euo pipefail

readonly HOST="singulance"
readonly DEPLOY_BRANCH="singulance-main"

usage() {
  cat <<'EOF'
Usage: bash scripts/singulance-engine.sh <command> [options]

Read-only commands:
  status                         Show deployed revision, containers, and health.
  logs <service> [lines]         Show recent logs for core, fe, control, employees, or tara.
  images                         Show only live and stable images for production services.
  release                        Show the deployed SHA marker and release ledger tail.

Controlled commands:
  deploy --confirm               Deploy canonical singulance-main through quick-deploy.
  rollback <service> --confirm   Roll one service back to its saved stable image.
  prune-images --confirm         Keep current and stable service images; remove older tags.

The script never accepts an arbitrary SSH host, branch, shell fragment, or image tag.
EOF
}

require_confirmation() {
  [[ "${1:-}" == "--confirm" ]] || {
    echo "Refusing destructive action without --confirm." >&2
    exit 2
  }
}

valid_service() {
  case "$1" in core|fe|control|employees|tara) return 0 ;; *) return 1 ;; esac
}

container_for() {
  case "$1" in
    core) echo hm-core ;;
    fe) echo hm-fe ;;
    control) echo hm-control ;;
    employees) echo hm-employees ;;
    tara) echo tara-deepgram ;;
  esac
}

remote() {
  ssh "$HOST" "$@"
}

status() {
  remote 'set -e
    echo "== deployed source =="
    printf "quick-deploy SHA: "; cat /root/.quickdeploy-last-sha 2>/dev/null || echo "not recorded"
    printf "checkout SHA: "; git -C /root/hivemind-next rev-parse HEAD 2>/dev/null || true
    echo "== containers =="
    docker ps --format "{{.Names}} | {{.Image}} | {{.Status}}" | grep -E "^(hm-core|hm-fe|hm-control|hm-employees|tara-deepgram)" || true
    echo "== core health =="
    curl -fsS --max-time 8 http://127.0.0.1:2026/health
    echo
    echo "== capacity =="
    df -h / | awk "NR==1 || NR==2"
    docker stats --no-stream --format "{{.Name}} {{.CPUPerc}} {{.MemUsage}}" hm-core hm-fe hm-control hm-employees tara-deepgram 2>/dev/null || true'
}

logs() {
  local service="${1:-}" lines="${2:-150}"
  valid_service "$service" || { echo "Unknown service: $service" >&2; usage; exit 2; }
  [[ "$lines" =~ ^[0-9]+$ ]] && (( lines >= 1 && lines <= 1000 )) || {
    echo "lines must be an integer from 1 to 1000" >&2; exit 2;
  }
  remote "docker logs --tail $lines $(container_for "$service") 2>&1"
}

images() {
  remote 'docker image ls --format "{{.Repository}}:{{.Tag}} | {{.ID}} | {{.CreatedSince}}" \
    | grep -E "^hivemind/(core-api|fe|control-plane|employees|tara-deepgram):(latest|stable|latest-single|stable-single)" || true
    echo "== running service image IDs =="
    docker inspect --format "{{.Name}} | {{.Image}} | {{.Config.Image}}" hm-core hm-fe hm-control hm-employees tara-deepgram 2>/dev/null || true'
}

release() {
  remote 'set -e
    printf "deploy marker: "; cat /root/.quickdeploy-last-sha 2>/dev/null || echo "not recorded"
    printf "canonical remote: "; git -C /root/hivemind-next ls-remote origin refs/heads/singulance-main | cut -f1
    echo "== latest ledger entries =="
    tail -40 /root/hivemind-next/docs/PRODUCTION_RELEASE.md 2>/dev/null || true'
}

deploy() {
  require_confirmation "${1:-}"
  echo "Deploying only canonical $DEPLOY_BRANCH through the approved production entrypoint."
  remote "bash /root/quick-deploy.sh $DEPLOY_BRANCH"
}

rollback() {
  local service="${1:-}" confirm="${2:-}"
  valid_service "$service" || { echo "Unknown service: $service" >&2; usage; exit 2; }
  require_confirmation "$confirm"
  local deploy_service
  case "$service" in control) deploy_service=control-plane ;; tara) deploy_service=tara-deepgram ;; *) deploy_service=$service ;; esac
  remote "bash /root/quick-deploy.sh --rollback $deploy_service"
}

prune_images() {
  require_confirmation "${1:-}"
  # Keep images currently referenced by containers plus the explicit stable tags.
  # Docker refuses removal of any image still used by a container.
  remote 'set -e
    keep_ids=$( {
      docker inspect --format "{{.Image}}" hm-core hm-fe hm-control hm-employees tara-deepgram 2>/dev/null || true
      docker image inspect --format "{{.Id}}" \
        hivemind/core-api:stable hivemind/control-plane:stable hivemind/employees:stable \
        hivemind/tara-deepgram:stable hivemind/fe:stable-single 2>/dev/null || true
    } | sort -u )
    echo "Keeping image IDs: $keep_ids"
    docker image ls --format "{{.Repository}}|{{.Tag}}|{{.ID}}" \
      | while IFS="|" read -r repository tag id; do
          case "$repository:$tag" in
            hivemind/*:latest|hivemind/*:stable|hivemind/*:latest-single|hivemind/*:stable-single) continue ;;
            hivemind/*:*) ;;
            *) continue ;;
          esac
          echo "$keep_ids" | grep -qx "$id" && continue
          echo "Removing obsolete tag $repository:$tag"
          docker image rm "$repository:$tag" || true
        done
    docker image prune -f
    docker builder prune -f --filter "until=168h"'
}

command="${1:-help}"
shift || true
case "$command" in
  status) status "$@" ;;
  logs) logs "$@" ;;
  images) images "$@" ;;
  release) release "$@" ;;
  deploy) deploy "$@" ;;
  rollback) rollback "$@" ;;
  prune-images) prune_images "$@" ;;
  help|-h|--help) usage ;;
  *) echo "Unknown command: $command" >&2; usage; exit 2 ;;
esac
