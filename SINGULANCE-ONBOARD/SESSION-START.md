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

- Production host: `root@singulancelabs.com` (hostname `SINGULANCE`).
- **Two checkouts, one build source.** `/root/hivemind` is the intentionally-dirty
  scratch — never pull, reset, or build from it (a `DEPLOY-SOURCE.md` there says
  so). The build source is `/root/hivemind-next` on `singulance-main`; that is
  what `quick-deploy.sh` builds from. The live SHA is `/root/.quickdeploy-last-sha`.
- **Deploy with `quick-deploy.sh`, not ad-hoc commands.** It rebuilds only
  changed services, saves the outgoing image as `:stable`, health-gates, and
  smokes. See [SHIPPING.md](SHIPPING.md). Core/control/employees are
  Compose-managed; do not replace them with ad-hoc `docker run`.
- **Roll back with** `bash /root/quick-deploy.sh --rollback <service>` — each
  service keeps exactly one `:stable` (last-known-good).
- **Before pushing, read [COLLABORATION.md](COLLABORATION.md).** `singulance-main`
  is shared: never force-push, stage only your own files, one deployer at a time.
  Unpushed commits on the box are wiped by the next deploy's force-checkout.
- Never print, browser-store, commit, or document production secrets. They come
  from `/root/hivemind/.env` at runtime, never baked into an image.

## Change-Specific Reading

| Task | Read first |
| --- | --- |
| Recall, ingestion, memory counts, `.amr` | [MEMORY-LAYER.md](MEMORY-LAYER.md), [`docs/architecture/04-pipeline.md`](../docs/architecture/04-pipeline.md), `core/src/server.js` |
| Users, orgs, plans, usage, billing | `core/src/control-plane-server.js`, `core/src/billing/`, [SECURITY.md](SECURITY.md) |
| Rooms, digital employees, simulation | [`docs/HYPERAGENTS_README.md`](../docs/HYPERAGENTS_README.md), `employees-service/`, `pages/HyperAgents.jsx` |
| Voice | `pages/TaraConfig.jsx`, TARA services, [PRODUCTS.md](PRODUCTS.md) |
| Self-host/BYOD | [`docs/architecture/03-byod-data-residency.md`](../docs/architecture/03-byod-data-residency.md), [`byod/TRANSPORT.md`](../byod/TRANSPORT.md), `byod/` |
| Shipping a feature / rollback | [SHIPPING.md](SHIPPING.md), [COLLABORATION.md](COLLABORATION.md) |
| Deploy/container cleanup | [OPERATIONS.md](OPERATIONS.md), [`.claude/INSTRUCTIONS.md`](../.claude/INSTRUCTIONS.md) |
| Security | [SECURITY.md](SECURITY.md), [`Security-hardening-journal.md`](../Security-hardening-journal.md) |

## Completion Standard

Make the smallest complete change, run focused checks, update durable docs only
if the contract changed, commit an independent rollback point, and state exactly
what was verified versus what still needs production evidence.
