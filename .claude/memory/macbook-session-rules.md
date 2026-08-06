# MacBook session rules

Standing operating instructions for any agent/developer working from a laptop
(not the shared Hetzner box) against this repo. The failure mode these exist to
prevent: a laptop session is further from the box's live state than any server
session, so drift it can't see is the default, not the exception.

## 1. You rebase. Server sessions merge — you don't get that luxury.
Server sessions branch off `origin/singulance-main`, edit in a worktree, and PR
back in. You do the same branch/PR flow, but **rebase onto `origin/singulance-main`
before every push**, not merge:
```
git fetch origin
git rebase origin/singulance-main
git push --force-with-lease origin <your-branch>
```
`--force-with-lease`, never `--force` — it refuses if someone else pushed to your
own branch name in the meantime, which a bare `--force` would silently clobber.
Never rebase or force-push anything that isn't your own feature branch.

## 2. `singulance-main` is the only deployable ref — full stop
You never deploy from your laptop directly. Your branch merges via PR, and
deployment happens from the box against a clean `singulance-main` checkout. If
you're tempted to `ssh` in and push a fix straight to a running container: don't.
That's the exact class of incident that produced the "deploy only named commits"
rule in `CLAUDE.md` — prod was once found running a dirty working tree that
existed in no committed branch anywhere, unreproducible.

## 3. Assume the box has moved. It has.
Before starting any session: `git fetch origin && git log origin/singulance-main -5`.
Multiple server sessions run in parallel on the box; by the time you open your
laptop, `singulance-main` has usually moved since you last looked. Do not assume
your last-known state of any script, schema, or compose file is current — check
[deploy-topology.md](deploy-topology.md) and this file's neighbors for what
changed, then verify against `git log`, not memory.

## 4. Before trusting a "critical" script, check it's actually merged
`git log --all -- <path>` showing commits does NOT mean the file is reachable
from `singulance-main`. Check with:
```
git merge-base --is-ancestor <commit> origin/singulance-main
```
This bit a server session directly: `release-lock.sh`, `release-canonical.sh`,
and `preflight-deploy.sh` were called by every deploy on the box for weeks while
existing as orphaned commits never merged into `singulance-main`. If you're
reading a script from a stale local clone or an old branch, verify it against the
box's live copy before trusting it — diff, don't assume.

## 5. High-conflict files: check the lock before touching them
`docker-compose.hetzner.yml`, the Prisma schema, and `scripts/release-lock.sh`
itself are the files most likely to collide with a server session editing the
same thing concurrently. Before editing any of them:
```
scripts/path-lock.sh status <path>
scripts/path-lock.sh acquire <path> "<what you're doing>"
```
This is advisory only — nothing enforces it — but it's the whole mechanism, so
actually check it and actually release it when done.

## 6. Record what you deploy, even from a distance
If your work results in a deploy (via the box, after merge), the deploying
session should call:
```
scripts/record-deployment.sh --service <name> --sha <sha> --image <tag> --rollback <prior-tag> --health true|false
```
so `logs/deployments.log` stays the single source of truth for "what's live" —
don't let a laptop-originated change become invisible in that log just because
you weren't the one who ran the deploy command.

## 7. No end-to-end autonomy yet
Do not self-decompose an envisioned end-state into unsupervised multi-step
changes against production, even from a laptop where the blast radius feels more
contained. The standing evidence bar (see the ops-instructions summary from
2026-08-06) hasn't been met — bounded, reviewed, one-PR-at-a-time work only,
until a run of sessions demonstrates clean verification discipline without this
kind of guardrail.

## 8. Verify, don't reason, about anything cross-machine
If something behaves differently on your laptop than what's described in these
docs, the running code on the box is ground truth, not this file, not your
memory of a prior session. Pull the box's actual file/config/log before
concluding there's drift — don't fix a "bug" that's actually a stale local copy.
