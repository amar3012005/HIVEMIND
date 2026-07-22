# Rollback manifest — stable image snapshot 2026-07-22

Every currently-running container image was tagged `:stable-20260722` so it can be
restored even if the mutable `prod-*`/`latest` tag is later overwritten. Immutable
image IDs (sha256) are recorded below — a tag can move, an ID cannot.

| Container | stable tag | source prod tag | image ID |
|---|---|---|---|
| hm-core | hivemind/core-api:stable-20260722 | prod-20260722-rmye01367541 (pre-update-fix) | sha256:d25024509c18 |
| hm-control | hivemind/control-plane:stable-20260722 | prod-20260720-b3ca804a | sha256:830031290c1b |
| hm-employees | hivemind/employees:stable-20260722 | prod-20260722-rmyd4f127595 | sha256:d855bf813aff |
| tara-deepgram | hivemind/tara-deepgram:stable-20260722 | prod-20260722-rmye01367541 | sha256:ddf0b1e9ea87 |
| hm-fe / next-fe | hivemind/fe:stable-20260722 | latest | sha256:a241df490822 |
| hm-byod-broker | hivemind/byod-broker:stable-20260722 | prod-20260715-8aa07a4b | sha256:ae0fe36a8468 |
| hm-playwright | hivemind/hm-playwright:stable-20260722 | prod-20260715-8aa07a4b | sha256:4177c43a4414 |
| hm-postgres | hivemind/postgres-age:stable-20260722 | 15-age-custom | sha256:6a6beaacde64 |
| hm-caddy | caddy:stable-20260722 | latest | sha256:af5fdcd76f2d |

Third-party pinned images (no stable tag needed — already immutable): qdrant/qdrant:v1.12.4,
redis:7-alpine, nangohq/nango-server:hosted, ghcr.io/docling-project/docling-serve:latest.

## Currently LIVE (after the 2026-07-22 update-fix deploy)
- **hm-core = `hivemind/core-api:prod-20260722-dd0fcf9a4`** (resilient hivemind_update_memory +
  title persistence + MCP failure logging; built on singulance-main `dd0fcf9a4`).
- Pre-fix rollback point for core = `hivemind/core-api:stable-20260722` (= prod-20260722-rmye01367541).

## How to roll back a single service
The stack is deployed via `docker compose` **with an explicit `--env-file`** (see the deploy
gotcha in [deploy-topology.md](deploy-topology.md)). To restore core to the pre-fix image:
```bash
cd /root/hivemind
# point VERSION (or edit the service image) at the stable tag, then recreate the service:
sed -i 's/^VERSION=.*/VERSION=stable-20260722/' .env          # only if all services share VERSION
docker compose --env-file /root/hivemind/.env -f infra/docker-compose.hetzner.yml up -d core
```
For a service whose image is NOT driven by ${VERSION}, retag then recreate:
```bash
docker tag hivemind/core-api:stable-20260722 hivemind/core-api:prod-20260722-dd0fcf9a4
docker compose --env-file /root/hivemind/.env -f infra/docker-compose.hetzner.yml up -d core
```
Verify after any rollback: `docker ps --filter name=hm-core` shows healthy, and
`docker logs hm-core --since 2m | grep "Recall warm-up complete"`.
