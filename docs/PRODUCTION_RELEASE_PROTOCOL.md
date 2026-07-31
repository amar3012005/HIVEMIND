# SINGULANCE Production Release Protocol

This is the mandatory release authority for Codex, Claude, humans, and CI.
If another document conflicts with this file, this file wins.

## Non-negotiable invariants

1. Production is only `ssh singulance`. Never deploy central SINGULANCE services to `myserver`.
2. Git is source truth. No production code may exist only in a container or server checkout.
3. A release is an exact parent-repo commit plus an exact `frontend/Da-vinci` commit.
4. Build only from a clean detached worktree at those commits. Never build from a shared or dirty checkout.
5. Production runs immutable release tags. `latest` and `stable` are aliases, never deployment inputs.
6. `VERSION` and `NEXT_VERSION` must contain the immutable release ID before Compose recreates services.
7. Never use `git reset --hard`, blind `git pull`, `docker cp`, or an unqualified deploy helper on production.
8. Never overwrite or discard another session's changes. Stop on an ownership conflict.
9. Database migrations are additive, backed up, resumable, and applied before incompatible code is promoted.
10. A build is not a deployment, and health is not acceptance. Verify the real user-facing behavior.

## Branch and ownership model

- Every task uses one named branch in the parent repo. Do not mix unrelated work into it.
- Frontend work uses one matching task branch in `frontend/Da-vinci`.
- Commit and push the frontend first. Then update and commit the parent repo's frontend gitlink.
- The parent release commit is the complete release declaration. A frontend commit not referenced by its gitlink is not releasable.
- Never deploy an uncommitted tree, a local-only commit, or a submodule with `+`, `-`, or `dirty` status.
- Before requesting review, rebase the feature branch onto the current `origin/hivemind-main`; if canonical moves before merge, rebase again and obtain a new review. Deploy only the SHA returned by `origin/hivemind-main` after merge, never the pre-merge branch SHA.
- Before editing, record `git branch --show-current`, `git status --short`, parent `HEAD`, frontend `HEAD`, and active production release.
- Parallel sessions must declare the files and services they own. If two sessions touch the same file or service, one must stop.

## Release identity

Use `prod-YYYYMMDD-<parent-short-sha>` as the immutable release ID. Record every promotion in
[`PRODUCTION_RELEASE.md`](./PRODUCTION_RELEASE.md) with:

- parent branch and full SHA;
- frontend branch and full SHA;
- image names and digests;
- migrations applied;
- runtime `VERSION` and `NEXT_VERSION`;
- acceptance evidence and rollback tags.

Never rebuild an existing release ID. A changed byte requires a new commit and release ID.

## Required workflow

### 1. Reconcile before editing

```bash
git fetch origin
git status --short --branch
git submodule status frontend/Da-vinci
git -C frontend/Da-vinci status --short --branch
ssh singulance 'grep -E "^(VERSION|NEXT_VERSION)=" /root/hivemind/.env /root/hivemind-next/.env.embedding-canary-runtime'
```

Stop if the intended files are dirty from another session, the frontend gitlink is wrong, or the running release differs from the ledger.

### 2. Build a complete commit chain

1. Make the smallest correct change and add focused regression coverage.
2. Run syntax, focused tests, lint/build, and `git diff --check`.
3. Commit and push frontend changes first.
4. Update the parent gitlink, then commit and push the parent branch.
5. Confirm both remote SHAs resolve exactly to the local SHAs.

No force-push, commit amendment, or history rewrite after a release candidate is built.

### 3. Prepare production safely

1. Inspect running containers, image digests, Compose files, disk/RAM, and recent fatal logs.
2. Back up PostgreSQL before schema or billing/auth changes; verify the backup is non-empty and checksummed.
3. Tag every currently running image with a timestamped rollback tag before replacing anything.
4. Fetch the pushed commit and create a detached clean worktree under `/root/builds/<release-id>`.
5. Assert the worktree SHA and clean status before building.
6. Build only affected services. Reuse unchanged verified image digests under the new release tag.

### 4. Promote without stale code

1. Tag candidates with the immutable release ID.
2. Set `/root/hivemind/.env` `VERSION=<release-id>` and the vNext runtime env `NEXT_VERSION=<release-id>`; back up both files first.
3. Render `docker compose config` and verify every affected service resolves to the immutable tag.
4. Recreate one service at a time with `--no-deps --force-recreate`.
5. Wait for its health gate before advancing.
6. Recreate the vNext frontend from `<release-id>-single`; never from a generic frontend tag.

Do not restart data services for an application-only release.

### 5. Acceptance gates

A release is not complete until all applicable gates pass:

- running image tag and digest match the release ledger;
- Core, Control, Employees, TARA, and frontend are healthy/running;
- public homepage, login, Overview, API health, Core health, and TARA health return expected status;
- authenticated bootstrap plus affected tenant-scoped routes pass using a disposable session;
- frontend lazy chunks contain release-specific markers, not only `main.js`;
- fresh fatal, panic, uncaught, unhandled, OOM, and migration error counts are zero;
- the changed feature is exercised end to end with no customer side effect unless explicitly authorized;
- old and sibling flows receive a regression smoke check.

On failure, stop promotion, restore the previous immutable tags/env values, recreate only affected services, and record the failure. Never repair a failed release in place.

### 6. Promote aliases and clean up

Only after acceptance:

- point `stable` and `latest` aliases to the accepted release for operator convenience;
- keep Compose pinned to the immutable release ID;
- retain timestamped rollback tags and the database backup;
- remove only the temporary worktree and dangling images/build cache;
- update `PRODUCTION_RELEASE.md` with proof, not intentions.

## Forbidden shortcuts

- Building from `/root/hivemind` or `/root/hivemind-next` when either is dirty.
- Assuming `latest`, a branch name, or a successful push is what production runs.
- Deploying only the frontend repo without updating the parent gitlink.
- Updating the parent gitlink without pushing the referenced frontend commit.
- Running `audit fix --force`, `prisma db push`, `migrate dev`, or destructive migrations on production.
- Restarting a container and claiming new code or env was loaded.
- Hot-patching a running container and calling it deployed.
- Pruning images before rollback tags are confirmed.
- Declaring success from health endpoints without authenticated and user-facing checks.

## Agent completion report

Every deployment report must state: release ID, parent SHA, frontend SHA, running image digests, migrations, tests, authenticated checks, public checks, error-log result, rollback reference, and any intentionally untested external side effect.
