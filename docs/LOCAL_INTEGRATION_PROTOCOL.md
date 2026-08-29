# SINGULANCE Local Integration Protocol

This protocol governs all local HIVEMIND worktrees and local Docker preview
deployments. It complements `docs/BRANCH_PROTOCOL.md`; it does not authorize a
production release.

## Branch Topology

```text
origin/singulance-main (production truth)
              |
              v
origin/singulance-local (tested local integration truth)
              |
              +-- codex/<session>
              +-- claude/<session>
              +-- session/<agent>-<topic>
```

- `singulance-main` remains the only production release branch.
- `singulance-local` is the only branch from which the shared local Docker
  preview stack may be rebuilt.
- Production changes flow into `singulance-local`, never automatically in the
  opposite direction.
- Feature sessions never commit directly to either shared branch.
- Never rebase or force-push `singulance-local`; it is shared history.

## Permanent Integration Worktree

Use one clean worktree only for integration:

```powershell
git fetch origin --prune
git worktree add C:\Users\AMAR\Documents\ChatGPT\HIVEMIND-local-main singulance-local
```

If the branch does not exist yet, create it from current production truth:

```powershell
git worktree add -b singulance-local C:\Users\AMAR\Documents\ChatGPT\HIVEMIND-local-main origin/singulance-main
git -C C:\Users\AMAR\Documents\ChatGPT\HIVEMIND-local-main push -u origin singulance-local
```

No feature development happens in this integration worktree.

## Session Start

Every local feature session starts from the latest local integration branch:

```powershell
git fetch origin --prune
git switch -c codex/<topic> origin/singulance-local
```

In an existing session branch:

```powershell
git fetch origin --prune
git rebase origin/singulance-local
```

Commit and push the session branch. Never clean, reset, stash, or overwrite
files belonging to another worktree.

## Serialized Integration

Only one session may integrate or rebuild the shared local stack at a time.
Before integration, confirm the permanent worktree is clean and no Docker
Compose build/up operation for the HIVEMIND project is running.

In `HIVEMIND-local-main`:

```powershell
git fetch origin --prune
git switch singulance-local
git pull --ff-only origin singulance-local
git merge --no-edit origin/singulance-main
git merge --no-ff --no-edit origin/<session-branch>
git status --short
git diff --check origin/singulance-local..HEAD
```

Rules:

1. Resolve conflicts by preserving both compatible changes; never select an
   entire side without reviewing the conflicting hunks.
2. Abort the merge if unrelated dirty files exist.
3. Validate the merged result, not only the session branch.
4. A failed integration stays local and must not be pushed.
5. If the remote push is rejected, fetch and merge the newer
   `origin/singulance-local`, rerun validation, then retry. Never force-push.

## Local Container Deployment

From the clean integration worktree, rebuild only affected services where
possible. For a full backend preview refresh:

```powershell
docker compose -f docker-compose.local-stack.yml -f docker-compose.local-services.yml up -d --build
docker compose -f docker-compose.local-stack.yml -f docker-compose.local-services.yml ps
```

When an additional test overlay is required, add its compose file explicitly;
do not silently make a feature-specific overlay mandatory for every developer.

Verify all affected health endpoints and at least one real changed route or UI
flow. The local deployment is accepted only after the containers are healthy
and focused checks pass. Then publish the tested integration state:

```powershell
git push origin singulance-local
```

Record the integrated session branch, resulting SHA, test commands, and local
runtime evidence in `docs/ENGINEERING_JOURNAL.md` and Agent Memory.

## Promotion to Production

`singulance-local` is never deployed to production. Promotion is a separate,
reviewed operation:

1. Create a release/session branch from `origin/singulance-main`.
2. Cherry-pick or merge only the accepted commits from `singulance-local`.
3. Rebase on current `origin/singulance-main` and run the production release
   protocol in `docs/PRODUCTION_RELEASE_PROTOCOL.md`.
4. Merge into `singulance-main` only after production acceptance checks pass.

This keeps local experiments and local-only feature flags out of production by
default.
