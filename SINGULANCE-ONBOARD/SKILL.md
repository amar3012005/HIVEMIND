---
name: singulance-production-release
description: Use for every SINGULANCE production build, deployment, rollback, image cleanup, or container investigation.
---

# SINGULANCE Production Release Skill

Read this before changing production.

## Host

Use `ssh root@singulance` when the Tailscale route is available. If it is not,
verify that `46.224.4.164` is still the DNS target for the public production
hosts, then use `ssh root@46.224.4.164`. Never use `myserver`; it is a
different, older host.

## Two-image rule

Each application service keeps exactly two deployable images:

- `stable`: the image currently serving before a promotion. This is rollback.
- `latest`: the fully validated release being served after promotion.

Application services are `core-api`, `control-plane`, `employees`, dashboard
frontend (`fe:latest-single`), and homepage frontend (`fe:home-latest`).
Database, Redis, Qdrant, Docling, Nango, and other vendor images are upgraded
only as explicit infrastructure changes; do not retag or prune their active
images as application releases.

## Release contract

1. Build immutable candidate tags from one committed root revision and one
   committed frontend revision.
2. Run syntax, focused contract tests, and image smoke checks before promotion.
3. Tag every running application image as `stable`.
4. Tag the validated candidates as `latest`.
5. Recreate the application services with `VERSION=latest` and
   `NEXT_VERSION=latest`.
6. Verify public health, authenticated bootstrap, login, memory access,
   HyperAgents, and frontend bundle labels.
7. Remove candidate and superseded application tags. Keep only `stable` and
   `latest`, then run `docker image prune -f` and `docker builder prune -af`.

## Migration rule

Never run `prisma migrate deploy` automatically at container startup. Before a
release, run a read-only schema diff. Apply only reviewed additive SQL with
`prisma db execute`; do not baseline, reset, or auto-apply a historical
migration chain on the live database.

## Immediate rollback

Retag `stable` as `latest`, then recreate only the affected services. Check
health before and after. Do not delete a `stable` image until the newer release
has passed production smoke checks.

