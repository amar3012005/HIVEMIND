# SINGULANCE Deployment Governor

This is the operational contract for every Codex, Claude, human, or CI session
that releases HIVEMIND, HyperAgents, TARA, or the frontend. It supplements the
formal release protocol with the operator-approved fast deployment path.

## Authority And Target

- Production is only the SSH host alias `singulance`. Never use `myserver`.
- `singulance-main` is the only deployable branch.
- `/root/hivemind-next` is the deploy checkout. Fetch the branch and use the
  resulting `FETCH_HEAD`; do not trust a possibly stale remote-tracking ref.
- `/root/quick-deploy.sh singulance-main` is the only normal deploy entrypoint.
- Run one deployment in the foreground. The script lock rejects concurrent runs.

## What "Run The Latest Code" Means

Containers run image contents, not files in Git. Pulling a commit cannot update
a container by itself.

The governor therefore follows this minimal rule:

1. If the fetched commit is already live, do nothing.
2. If no deployable service changed, do nothing.
3. If a service changed, rebuild only that service using Docker's warm cache.
4. Verify the image revision label equals the fetched commit before recreation.
5. Save the outgoing image as the single `stable` rollback, then recreate only
   the changed service.

The deploy path never clears the full Docker build cache and never rebuilds an
unchanged service. Cache cleanup is a separate maintenance operation, not part
of releasing software.

## Sources Of Truth

Read these before deployment, in this order:

1. `docs/BRANCH_PROTOCOL.md` for branch and frontend-gitlink ownership.
2. `docs/PRODUCTION_RELEASE_PROTOCOL.md` for safety and acceptance invariants.
3. `docs/PRODUCTION_RELEASE.md` for the last formally accepted release.
4. `docs/ENGINEERING_JOURNAL.md` and `git log origin/singulance-main` for history.
5. `/root/.quickdeploy-last-sha`, running container image IDs, and public routes
   for current runtime truth.

The ledger may lag. A branch may also be ahead of production. Never infer the
running state from either alone; compare Git, the deploy marker, container image
labels, and served behavior.

## Preflight

- Confirm the intended parent commit is pushed to `origin/singulance-main`.
- For frontend changes, confirm the referenced `frontend/Da-vinci` SHA is pushed
  before the parent gitlink is advanced.
- Compare the fetched SHA with `/root/.quickdeploy-last-sha`.
- Inspect changed paths and let `quick-deploy.sh` select affected services.
- For migrations, require additive idempotent SQL and a PostgreSQL backup first.
- Confirm enough disk and memory remain for the affected build.
- Do not expose secrets in output, journals, image labels, or commands.

## Deployment

```bash
ssh singulance 'cd /root/hivemind-next \
  && git -c submodule.recurse=false -c fetch.recurseSubmodules=false fetch origin singulance-main -q \
  && git show FETCH_HEAD:scripts/quick-deploy.sh > /root/quick-deploy.sh \
  && chmod +x /root/quick-deploy.sh \
  && /root/quick-deploy.sh singulance-main'
```

Wait for completion. Do not run it in the background and do not start another
deployment while it is active.

## Acceptance

- Confirm every affected container is healthy and its image revision label
  equals the fetched `singulance-main` commit.
- Check fresh logs for fatal, panic, uncaught, unhandled, OOM, and migration
  failures.
- Verify the affected route or served UI marker. Health alone is insufficient.
- Verify one sibling flow so a focused change did not hide a regression.
- Only then update the engineering journal or release ledger as accepted.

## Rollback

```bash
ssh singulance '/root/quick-deploy.sh --rollback <service>'
```

Rollback uses the one saved `stable` image and does not rebuild. After rollback,
verify health, the affected route, and logs, then record the failed release.

## Stop Conditions

Stop instead of deploying when:

- the target is not `singulance`;
- the intended commit or frontend gitlink is not pushed;
- another deploy holds the production lock;
- a migration is destructive, non-idempotent, or lacks a verified backup;
- the built image revision does not equal `FETCH_HEAD`;
- the affected route fails after health becomes ready;
- rollback image verification fails.

## Incident Lessons Encoded Here

- Stale `origin/singulance-main` refs previously rebuilt old code; use
  `FETCH_HEAD` from the current fetch.
- Recursive submodule fetch previously failed on stale frontend history; fetch
  non-recursively and update only `frontend/Da-vinci`.
- An unpushed frontend SHA previously broke every production checkout; push the
  frontend first, then the parent gitlink.
- Shared dirty checkouts caused sessions to overwrite work; feature work stays
  on isolated branches/worktrees and only complete work reaches
  `singulance-main`.
- Full cache pruning made every build cold; deployment performs no automatic
  broad cache deletion.
- Healthy old containers previously hid stale code; verify the image revision
  and the changed user-facing behavior.

