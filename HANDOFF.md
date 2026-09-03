# HIVEMIND / SINGULANCE — New Agent Handoff

Read this file first when taking over work in this repository. It is a short
operational map, not a replacement for the governing documents listed below.

## The platform in one page

SINGULANCE is an organization-scoped AI operating system. Every request,
memory, artifact, connector action, room, and lifecycle event must preserve the
authenticated user, organization, scope, authority, and audit context.

| Area | Owner | What it must remain responsible for |
| --- | --- | --- |
| HIVEMIND memory engine | `core/`, `hm-core`, PostgreSQL, Qdrant | Canonical documents, evidence, memories, entities, canonical claims, citations, retrieval, provenance, tenant isolation, and storage-mode parity (managed, embedded, hybrid, BYOD, `.amr`). |
| Control plane | `core/src/control-plane-server.js`, `hm-control` | Authenticated public API/proxy, lifecycle orchestration, notifications, policy, approvals, billing boundaries, and external routing. It coordinates; it does not invent specialist work. |
| HyperAgents / Rooms | `employees-service/`, `hm-employees` | Room roster, Director-selected playbooks, durable work orders/results, artifact verification, governed tool use, and room events. Persisted artifacts, source references, receipts, and predicate verdicts—not prose—are completion evidence. |
| TARA voice | TARA services and adapters | Voice/session orchestration, transcription/voice provider integration, user consent and approval boundaries. Keep voice events tenant-scoped and route enduring facts through canonical HIVEMIND materialization. |
| Frontend | `frontend/Da-vinci` submodule | The customer web app. Commit and push it before advancing the parent gitlink. |
| Cloudflare | `workers/`, Worker configs, Flagship | Edge delivery, feature flags, Workflows/Queues where explicitly used, AI Gateway, and observability. It is not the semantic source of truth for customer memory. |

Authoritative architecture and operating rules:

- [`AGENTS.md`](./AGENTS.md): global safety, memory, runtime, and deployment rules.
- [`docs/BRANCH_PROTOCOL.md`](./docs/BRANCH_PROTOCOL.md): branch/worktree ownership.
- [`docs/PRODUCTION_RELEASE_PROTOCOL.md`](./docs/PRODUCTION_RELEASE_PROTOCOL.md): release invariants and acceptance gates.
- [`DEPLOY_GOVERNOR.md`](./DEPLOY_GOVERNOR.md): the only supported fast production deployment path.
- [`docs/ENGINEERING_JOURNAL.md`](./docs/ENGINEERING_JOURNAL.md) and [`docs/PRODUCTION_RELEASE.md`](./docs/PRODUCTION_RELEASE.md): verified history and accepted releases.

## Non-negotiable platform rules

1. Scope every read and write by the authenticated organization and user. Never
   use a client-provided organization identifier as authority.
2. PostgreSQL and the tenant's authorized Memory Box are lifecycle/semantic
   truth; Qdrant is an index, not authorization truth. Cloudflare is an
   execution and edge layer, not a replacement memory store.
3. Use the canonical ingestion/materialization funnel for memories, evidence,
   entities, claims, relationships, citations, and vectors. Do not create a
   parallel write path for a new feature.
4. HyperAgent work must be bounded, persisted, receipt-backed, and approval
   gated for external side effects. A model response alone is never proof that
   work happened.
5. Keep feature flags fail-closed and latch a selected runtime mode/version at
   admission. Flag-off behavior must preserve the stable path.
6. Never log, commit, journal, or copy secrets, tokens, cookies, private keys,
   personal data, or customer artifacts.

## Start a safe worktree from `singulance-main`

Do not edit a shared or dirty checkout. In PowerShell, from a clean parent
checkout, create a named private branch and worktree:

```powershell
git fetch origin singulance-main
git worktree add -b codex/<topic> P:\HIVEMIND-worktrees\<topic> origin/singulance-main
Set-Location P:\HIVEMIND-worktrees\<topic>
git submodule update --init --recursive
git status --short --branch
git submodule status frontend/Da-vinci
```

Before non-trivial work, read `AGENTS.md`, run the required shared-memory
health/history checks when available, inspect the relevant decision docs and
current code, and record the branch, worktree, files, and intended service.
Preserve unrelated changes; never reset, clean, stash, or overwrite another
session's work.

For local-integration work, read
[`docs/LOCAL_INTEGRATION_PROTOCOL.md`](./docs/LOCAL_INTEGRATION_PROTOCOL.md)
and base the private branch on `origin/singulance-local` instead. Never deploy
that branch to production.

## Build, test, and prove a change

1. Make the smallest compatible change. Add focused regression coverage before
   refactoring a critical path.
2. Run `git diff --check`, syntax/type checks, and the changed service's
   focused test suite. Run frontend lint/build for frontend work and migration
   validation for schema work.
3. Test the real contract, not just an internal helper. Use an authenticated,
   disposable tenant/session for protected routes; do not place credentials in
   shell history or output.
4. Validate the affected behavior locally or in the intended isolated preview,
   then verify a sibling flow remains healthy.

Minimum public smoke checks after a production release:

```powershell
curl.exe -fsS https://api.singulancelabs.com/health
curl.exe -fsSI https://next.singulancelabs.com/
```

These checks do not replace authenticated acceptance for a changed feature.

## Commit, push, and integrate

```powershell
git add <only-owned-files>
git commit -m "<type>: <clear change>"
git push -u origin codex/<topic>

git fetch origin singulance-main
git rebase origin/singulance-main
git diff --check
# Re-run focused tests after the rebase.
git push --force-with-lease origin codex/<topic>
```

Only a complete, tested branch may be merged serially in the clean permanent
`singulance-main` integration worktree. Frontend changes require this order:

1. Commit and push `frontend/Da-vinci`.
2. Verify the referenced frontend SHA exists remotely.
3. Commit and push the parent gitlink update.
4. Merge the complete parent branch into `singulance-main`.

Never point the parent repo at a local-only frontend commit.

## Governed production deployment

Production is **only** `ssh singulance`; never use `myserver`. Before release,
read the three governing release documents above, inspect the current release
ledger, and check the release mailbox:

```bash
ssh singulance "RELEASE_SESSION_ID=<short-topic> /root/hivemind/scripts/release-presence.sh status"
```

Deploy only after the intended commit is pushed to `origin/singulance-main`.
The governor creates a clean detached worktree, uses cached builds, and
recreates only affected services. A service-scoped release is preferred when
the affected service is known:

```bash
ssh singulance 'cd /root/hivemind-next \
  && git -c submodule.recurse=false -c fetch.recurseSubmodules=false fetch origin singulance-main -q \
  && git show FETCH_HEAD:scripts/quick-deploy.sh > /root/quick-deploy.sh \
  && chmod +x /root/quick-deploy.sh \
  && RELEASE_SESSION_ID=<short-topic> /root/quick-deploy.sh singulance-main <service>'
```

Run in the foreground and wait for `RELEASE OK`. Do not manually rebuild all
containers, hot-patch a running container, use blind `git pull`, or prune
Docker caches as part of a release. For a rollback, use:

```bash
ssh singulance '/root/quick-deploy.sh --rollback <service>'
```

After deployment, verify the exact image revision, service health, affected
authenticated flow, public route/UI, and fresh logs for fatal/panic/uncaught/
unhandled/OOM/migration errors. Then append evidence—commit SHA, tests, runtime
checks, manifest, and rollback reference—to the engineering journal and release
ledger. Do not describe uncommitted or unverified work as released.

## Stop and escalate instead of guessing

Stop a release when there is a conflicting service claim, dirty shared checkout,
unpushed gitlink, destructive/non-idempotent migration, missing backup,
unauthorized external effect, unhealthy acceptance route, or any uncertainty
about tenant authority. Preserve evidence and leave a precise handoff.
