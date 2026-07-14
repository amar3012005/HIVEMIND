# SINGULANCE — single ground-truth branch

**`singulance-main` (parent repo) + `singulance-main` (frontend/Da-vinci) are the ONLY
source of truth for the SINGULANCE production engine.** They always point at the code of
the currently ACCEPTED production release.

Rules (supplement to the SINGULANCE Production Release Protocol — that protocol still wins
on process; this file fixes the branch model):

1. Every change branches off `singulance-main` (`fix/…`, `feat/…`). Never off a feature
   lineage, never off an old release branch.
2. Frontend first: matching task branch off frontend `singulance-main`, push, then bump the
   parent gitlink on the parent task branch.
3. Release = build + promote from the task branch per protocol. ON ACCEPTANCE, fast-forward
   (or merge --ff-only) `singulance-main` in BOTH repos to the released commits and push.
   `singulance-main` may never contain unreleased code.
4. If `singulance-main` cannot fast-forward to your release commit, you branched from a
   stale point — REBASE ONTO CURRENT `singulance-main` and rebuild. Never force-push, never
   promote a release that isn't a descendant of `singulance-main`.
5. Other lineages (`feat/mneme-foundation`, `codex/*`, old `feature-loop/*`) are upstream
   development lines. Nothing deploys from them directly — cherry-pick/merge into a task
   branch off `singulance-main`.
6. `/root/hivemind-next` on the server stays checked out on `singulance-main` so the box
   reflects ground truth; builds still use detached worktrees per protocol.

History note: created 2026-07-14 at `77c3af92` (= accepted release prod-20260714-8d74e135)
after parallel sessions repeatedly regressed each other by deploying from diverged branches.
