# HIVEMIND Engineering Journal

This is the human-readable index of committed work and accepted production
releases. Git is the source of truth; every entry must cite immutable commit
SHAs, release IDs, and verification evidence. Do not record plans, guesses,
or uncommitted changes as completed work.

## Required Session Protocol

1. At session start, read the latest entries, `git log origin/hivemind-main`,
   `docs/PRODUCTION_RELEASE.md`, and `docs/PRODUCTION_RELEASE_PROTOCOL.md`.
2. Before coding, add a `Started` entry with the branch, owner, scope, and
   base SHA. Do not claim an outcome yet.
3. After a pushed code commit, append a `Committed` entry that links only the
   pushed SHA and affected files/services.
4. After production acceptance, append an `Accepted release` entry with the
   immutable release ID, running image digests, verification evidence, and
   rollback tag. Update `PRODUCTION_RELEASE.md` in the same commit.
5. If a release fails or is rolled back, append the failure and rollback
   reference. Never edit, delete, or rewrite older entries.

## Canonical Merge Gate

Before asking for review, run `git fetch origin` and rebase the feature branch
onto `origin/hivemind-main`. If `hivemind-main` moves before merge, repeat the
rebase and request review again. After merge, resolve the SHA from
`origin/hivemind-main`; that post-merge SHA is the only permitted production
build input. A feature-branch SHA, old release tag, or local checkout can
never be deployed.

## Entry Template

```md
## YYYY-MM-DD UTC - Short outcome

- State: Started | Committed | Accepted release | Rolled back | Blocked
- Owner: Claude | Codex | Human
- Branch: `branch-name`
- Base / commit: `base-sha` -> `pushed-sha`
- Scope: files and production services changed
- Verification: exact command, test, curl, or `not run`
- Production: release ID, image digest, and runtime tag; `not deployed` if absent
- Rollback: immutable tag or `not applicable`
- Next: one concrete next action
```

## Current Git Baseline

## 2026-07-16 UTC - Canonical maps and Elements baseline

- State: Committed
- Owner: prior release session
- Branch: `hivemind-main`
- Base / commit: `19fa016d` -> `3a500111c3ae8fbe62aef12604cf95bdb629af51`
- Scope: Google Maps connector catalog, HyperAgents Elements frontend, and
  release-ledger documentation.
- Verification: Git remote history only; this entry does not claim live
  runtime acceptance.
- Production: consult `docs/PRODUCTION_RELEASE.md` and the running image tags.
- Rollback: not applicable
- Next: reconcile any new feature branch into `hivemind-main` before release.
