# Operations

## Current Deployment Model

SINGULANCE runs Docker Compose on one 16 GB production host. Keep Compose for
now: single-node Kubernetes/k3s adds overhead but cannot survive loss of that
one host. Adopt an orchestrator only after at least three nodes, external/shared
data services, load balancing, and a real deployment/rollback pipeline exist.

The production-compatible frontend is `next.singulancelabs.com`; core is
`core.singulancelabs.com`; control plane is `api.singulancelabs.com`. Do not
send new traffic to a legacy route unless routing and compatibility are verified.

## Deployment Rules

- The host source checkout is not a build source. Build only from the clean
  deployment checkout specified in [SESSION-START.md](SESSION-START.md).
- Use the production Compose file plus its env file on every command.
- Tag the running image as rollback before changing a service.
- Recreate only the changed service, then check core health, control bootstrap,
  and the changed frontend route.
- Split a silent combined probe into individual health/status/log checks.
- Do not deploy source changes, migrations, and unrelated cleanup as one step.

## Containers and Resource Discipline

The host has a primary `hm-*` stack and temporary `hivemind-next-*` canary
services. Container names, images, limits, and resource use are live facts:
inspect `docker ps`, `docker stats`, Compose config, Caddy routes, and health
endpoints before a retirement decision.

A previous baseline showed low CPU pressure but roughly 85% root-disk use. Disk
pressure is the immediate availability risk. Do not prune blindly: backups,
images, stopped containers, and canaries have different safety and rollback
implications.

### Safe Canary/Container Retirement Gate

All conditions must be true before removing an idle canary service:

1. Prove Caddy and frontend routing send no customer request to it.
2. Prove the primary replacement is healthy and critical user flows work.
3. Preserve an immutable rollback image and record its tag.
4. Identify data volumes and prove the service owns no unique customer data.
5. Stop only the candidate service first, wait, and run smoke checks.
6. Remove stopped containers/images separately after the wait period.
7. Never delete PostgreSQL, Qdrant, Redis, or customer volumes as cleanup.

No prune command belongs in a generic runbook. Cleanup needs a dated inventory
and a reviewed list of exact targets.

## Resilience Priorities

1. Enforce resource limits, health checks, and restart policies for active
   runtime services.
2. Keep PostgreSQL and Qdrant backups encrypted, scheduled, freshness-checked,
   and restore-tested.
3. Add off-host encrypted backup delivery. Local backups do not survive host loss.
4. Monitor disk, memory, CPU, health, queue depth, error rate, and backup
   freshness; alert before saturation.
5. Separate critical data services or use managed services before adding
   orchestration complexity.

See [`Security-hardening-journal.md`](../Security-hardening-journal.md) for
backup/restore evidence and the open off-host backup work.
