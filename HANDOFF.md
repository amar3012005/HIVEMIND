# HIVE native Harness chat handoff

## Authority and scope

- Branch: `codex/hive-chat-origin-compose` from locked local setup `3023a035d`.
- Baseline: `origin/singulance-local` `0035027205b84e60e58fefa5ca0f1aa95cea2adc`.
- Harness: `amar3012005/deepseek-harness-hivemind` `hivemind-chat` `980a9d66e373d9c3a1a29f249968c44991280d18`.
- Da-vinci gitlink: `c0032dd4de663476f8f55d061a847dbf9bfeb8ed`.
- `singulance-main` and production were not changed.

## Canonical architecture

Use `./scripts/harness-chat-env` only. One Compose file:

`infra/docker-compose.hivemind-chat.yml`

Project `hivemind-chat-local`, network `hivemind-network`. Browser stays on
`https://next.preview.singulancelabs.com`. Cloudflare Worker keeps Da-vinci
static assets. One named tunnel delivers traffic to Caddy `origin-gateway`.
Internal calls use Compose DNS: `core`, `control-plane`, `harness-runner`.

## Agent 1 work

- Replaced the three-file transitional composition with one complete model.
- Added Caddy origin gateway and in-project cloudflared with committed ingress.
- Mapped existing postgres/qdrant/docling volumes; added redis volume.
- Doctor rejects duplicate projects, foreign/compat containers, floating
  Harness SHAs, and package bind mounts.
- `up` rebuilds only the runner; `up-all` is first boot.

## Runtime after Agent 1 cutover

Local Compose project `hivemind-chat-local` is up: core, control-plane,
harness-runner, origin-gateway, employees, postgres, redis, qdrant, nango,
playwright, docling, cloudflared. Local Caddy `http://127.0.0.1:18080/health`
and Host-header routes for preview-api/preview return 200.

Public `next.preview.singulancelabs.com` still returns 200 from the Cloudflare
Worker. `preview-api` and `preview.singulancelabs.com` currently return 530
because those hostnames were on the old token tunnel we removed. Point those
hostnames at named tunnel `c5dbf395-9e2b-40aa-b033-bcf85bde0240`, then recheck.

Do not delete volumes. Do not edit `singulance-main`.
