# Session Start

Use this before changing SINGULANCE. It prevents stale assumptions, unsafe
production work, and untraced tenant-boundary changes.

## Orientation

1. Read [README.md](README.md), then the task-relevant topic document.
2. Read [`.claude/INSTRUCTIONS.md`](../.claude/INSTRUCTIONS.md),
   [`.claude/MEMORY.md`](../.claude/MEMORY.md), and, for security/operations,
   [`Security-hardening-journal.md`](../Security-hardening-journal.md).
3. Run `git status --short` before editing. Never revert user/other-agent work
   merely to make the tree clean.
4. Use the code-review graph before filesystem search. Trace callers and tests
   before changing shared core/control/tenant code.
5. Establish whether the task is source-only, canary-only, or production.
   Production facts drift: inspect health, routes, containers, and logs first.

## Production Safety

- Production host: `root@singulancelabs.com`.
- `/root/hivemind` is intentionally dirty. Never pull, reset, or build from it.
- Build from the clean deployment checkout specified in
  [`.claude/INSTRUCTIONS.md`](../.claude/INSTRUCTIONS.md).
- Use `/root/hivemind/infra/docker-compose.hetzner.yml` **with**
  `--env-file /root/hivemind/.env` for every production Compose command.
- Core and control are Compose-managed. Do not replace them with ad-hoc
  `docker run` commands.
- Preserve a timestamped rollback image before recreating a changed service;
  recreate only that service and run cold public health checks.
- Never print, browser-store, commit, or document production secrets.

## Change-Specific Reading

| Task | Read first |
| --- | --- |
| Recall, ingestion, memory counts, `.amr` | [MEMORY-LAYER.md](MEMORY-LAYER.md), [`docs/architecture/04-pipeline.md`](../docs/architecture/04-pipeline.md), `core/src/server.js` |
| Users, orgs, plans, usage, billing | `core/src/control-plane-server.js`, `core/src/billing/`, [SECURITY.md](SECURITY.md) |
| Rooms, digital employees, simulation | [`docs/HYPERAGENTS_README.md`](../docs/HYPERAGENTS_README.md), `employees-service/`, `pages/HyperAgents.jsx` |
| Voice | `pages/TaraConfig.jsx`, TARA services, [PRODUCTS.md](PRODUCTS.md) |
| Self-host/BYOD | [`docs/architecture/03-byod-data-residency.md`](../docs/architecture/03-byod-data-residency.md), [`byod/TRANSPORT.md`](../byod/TRANSPORT.md), `byod/` |
| Deploy/container cleanup | [OPERATIONS.md](OPERATIONS.md), [`.claude/INSTRUCTIONS.md`](../.claude/INSTRUCTIONS.md) |
| Security | [SECURITY.md](SECURITY.md), [`Security-hardening-journal.md`](../Security-hardening-journal.md) |

## Completion Standard

Make the smallest complete change, run focused checks, update durable docs only
if the contract changed, commit an independent rollback point, and state exactly
what was verified versus what still needs production evidence.
