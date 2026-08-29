# SINGULANCE Branch Protocol

This is the working model for Codex, Claude, humans, and any other agent editing
HIVEMIND. It prevents sessions from overwriting each other while keeping the
production deploy path fast.

If another document conflicts with this file about branch ownership, this file
wins. Production deployment is still governed by
`SINGULANCE-ONBOARD/DEPLOYMENT.md` and `docs/PRODUCTION_RELEASE_PROTOCOL.md`.

## Core Model

```text
work branch   -> review/rebase -> singulance-main -> quick-deploy -> production
```

- `singulance-main` is the only deploy branch.
- Agents do not commit directly to `singulance-main` during feature work.
- Every session works on its own branch or worktree.
- Integration happens by rebasing on latest `origin/singulance-main`, resolving
  conflicts locally, then merging or fast-forwarding into `singulance-main`.
- Production only pulls `singulance-main` and runs `/root/quick-deploy.sh`.

Local multi-worktree integration is governed separately by
[`LOCAL_INTEGRATION_PROTOCOL.md`](LOCAL_INTEGRATION_PROTOCOL.md). Its shared
branch is `singulance-local`; it is for tested local Docker preview builds only
and is never a production deploy source.

## Why This Exists

Recent deploy failures came from shared mutable state:

- one session overwrote another session's uncommitted recall work in a shared
  checkout;
- a parent repo gitlink pointed at an unpushed frontend commit, breaking
  production submodule update;
- multiple sessions pushed partial states to `singulance-main`, so production
  was not one tested release line.

This protocol makes those failure modes mechanical errors instead of normal
workflow.

## Branch Rules

| Rule | Required behavior |
|---|---|
| Deploy branch | `singulance-main` only. |
| Work branch | Use `codex/<topic>`, `claude/<topic>`, or `session/<agent>-<topic>`. |
| Shared checkout | Never use one dirty checkout for multiple sessions. |
| Direct commits | Do not commit feature work directly to `singulance-main`. |
| Backup | Commit early and push the session branch before risky edits. |
| Rebase | Rebase on `origin/singulance-main` before integration. |
| Merge | Merge only the complete tested state. |
| Deploy | Deploy only after `singulance-main` contains the intended commits. |

## Frontend Gitlink Rule

Frontend changes are two-step:

1. Commit and push the `frontend/Da-vinci` commit first.
2. Update the parent repo gitlink and commit that parent change second.

The parent repo must never point to a local-only frontend commit. Before pushing
the parent commit, verify:

```bash
git -C frontend/Da-vinci rev-parse HEAD
git -C frontend/Da-vinci ls-remote origin HEAD
git submodule status frontend/Da-vinci
```

The exact frontend SHA in the gitlink must be reachable from a pushed frontend
branch.

## Production Deploy Rule

Day-to-day deploys use the fast path:

```bash
ssh singulance 'cd /root/hivemind-next && git fetch origin singulance-main -q \
  && git show FETCH_HEAD:scripts/quick-deploy.sh > /root/quick-deploy.sh \
  && chmod +x /root/quick-deploy.sh && bash /root/quick-deploy.sh singulance-main'
```

Hard requirements:

- run in the foreground and wait;
- one deploy at a time;
- verify the affected route or UI, not only `/health`;
- rollback with `bash /root/quick-deploy.sh --rollback <service>`;
- never deploy central SINGULANCE services from `myserver`.

## Session Start Checklist

Every session starts with:

```bash
git fetch origin singulance-main
git status --short --branch
git branch --show-current
git submodule status frontend/Da-vinci
git -C frontend/Da-vinci status --short --branch
```

If the checkout has unrelated dirty files, do not clean them. Create or switch
to a separate worktree/branch and leave the unrelated work alone.

## Integration Checklist

Before merging to `singulance-main`:

```bash
git fetch origin singulance-main
git rebase origin/singulance-main
git status --short
git diff --check
```

Then run the focused checks for the changed area:

- core: syntax plus affected unit/integration tests and route curl after deploy;
- frontend: build or lint where practical, then served-bundle/UI marker after
  deploy;
- employees: Python syntax/tests and HyperAgents affected route/run check;
- TARA: sidecar syntax/tests and live voice/session route check;
- migrations: backup first, additive SQL only, apply before incompatible code.

## Forbidden

- Do not push an untested partial state to `singulance-main`.
- Do not point the parent repo at an unpushed frontend commit.
- Do not use `git reset --hard` to clean another session's work.
- Do not deploy from a dirty shared checkout.
- Do not hot-patch a running container and call it deployed.
- Do not run manual container surgery when `quick-deploy.sh` can handle the
  service.

## Lightweight Exception

For emergency production fixes, a human may authorize direct work on
`singulance-main`. The session must still:

- fetch first;
- verify no conflicting session owns the same files;
- commit and push before deploy;
- deploy through `/root/quick-deploy.sh`;
- write the release evidence after verification.
