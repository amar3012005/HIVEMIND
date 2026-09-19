# EveryAgent

This directory is the repository's versioned ground truth for engineering work. It applies to every
agent and every worktree derived from this branch.

## Fast start

1. Read `.hivemind/README.md` and select the one relevant skill using `ROUTING.json`.
2. Start from local `production-base` (which tracks `origin/singulance-main`) and create a new
   task branch/worktree. Do not try to check out `singulance-main` locally.
3. Implement the requested change, run the focused check for the boundary you changed, then commit
   and push the task branch.
4. For a release, follow the selected skill's owning artifact path and verify the changed public
   route. Record the deployed revision and rollback identity in the normal release record.

## Execution

- Prefer the smallest complete change that fixes the demonstrated boundary.
- Work directly; optional ledgers, model routing, and broad legacy guidance do not block a normal
  feature or release.
- The selected skill is the procedure. Use the Ops Gateway when available for deployments instead
  of reconstructing server commands or editing live containers.
- Recreate only the owning service and verify its real route after release.

## Finish

Report the source SHA, changed files, focused check, deployed artifact/version when applicable, and
rollback identity. Never put credentials or raw environment values in a commit or task note.
