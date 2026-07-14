---
name: singulance-production-release
description: Use for every SINGULANCE production build, deployment, rollback, image cleanup, or container investigation.
---

# SINGULANCE Production Release Skill

Read [`../docs/PRODUCTION_RELEASE_PROTOCOL.md`](../docs/PRODUCTION_RELEASE_PROTOCOL.md)
and [`../docs/PRODUCTION_RELEASE.md`](../docs/PRODUCTION_RELEASE.md) before changing production.
Those files are authoritative if this summary ever drifts.

## Host

Use `ssh root@singulance` when the Tailscale route is available. If it is not,
verify that `46.224.4.164` is still the DNS target for the public production
hosts, then use `ssh root@46.224.4.164`. Never use `myserver`; it is a
different, older host.

## Image rule

Production Compose runs only immutable `prod-YYYYMMDD-<parent-sha>` tags.
Aliases are operator conveniences, not deployment inputs:

- `stable` and `latest`: the currently accepted release.
- `rollback-<timestamp>`: the prior running digest retained for rollback.

Application services are `core-api`, `control-plane`, `employees`, dashboard
frontend (`fe:<release>-single`), and homepage frontend when explicitly included.
Database, Redis, Qdrant, Docling, Nango, and other vendor images are upgraded
only as explicit infrastructure changes; do not retag or prune their active
images as application releases.

## Release contract

1. Build immutable release tags from one pushed parent revision and its exact
   pushed frontend gitlink revision, using clean detached worktrees.
2. Run syntax, focused contract tests, and image smoke checks before promotion.
3. Tag every running application image with a timestamped rollback tag.
4. Pin `VERSION` and `NEXT_VERSION` to the immutable release ID.
5. Render Compose config, then recreate one affected service at a time.
6. Verify public health, authenticated bootstrap, login, memory access,
   HyperAgents, and frontend bundle labels.
7. After acceptance, move `stable` and `latest` aliases to the accepted digest,
   retain rollback tags, and prune only dangling images/build cache.

## Migration rule

Never run `prisma migrate deploy` automatically at container startup. Before a
release, run a read-only schema diff. Apply only reviewed additive SQL with
`prisma db execute`; do not baseline, reset, or auto-apply a historical
migration chain on the live database.

## Immediate rollback

Restore the prior immutable `VERSION`/`NEXT_VERSION` values (or timestamped
rollback image tags), render Compose config, and recreate only affected services.
Check health before and after; never repair a failed release tag in place.
