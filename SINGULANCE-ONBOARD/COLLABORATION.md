# Collaboration — parallel agents, zero overwrites

Multiple agents work on SINGULANCE at once: **Claude on the box**
(`root@singulancelabs.com`, builds and deploys) and **Codex on a developer's
localhost** (writes code, pushes). Plus humans. This document is the contract
that keeps them from clobbering each other's work or shipping mistakes.

> This is not theoretical. While these docs were being written, a deploy ran and
> force-reset the box build source to the branch tip — silently discarding an
> unpushed local commit. The lesson is baked into the rules below: **only a push
> to `singulance-main` is durable.**

## The mental model

- **`singulance-main` is the single source of truth and the only deploy branch.**
  Everything that reaches production goes through it.
- **The box does not author features.** Claude on the box builds and deploys what
  is already on `singulance-main`. It force-resets the build source to the branch
  tip on every deploy — so **any uncommitted or unpushed work sitting on the box
  will be discarded**. Never leave work-in-progress only on the box.
- **Codex/localhost authors features**, commits with the correct author, and
  pushes to `singulance-main`. Only then is it real. "It works on my machine /
  it's on my local branch" means production does **not** have it.

## Non-negotiable rules (how to never commit a mistake)

1. **Stage only your own files.** `git add <explicit paths>`. Never
   `git add -A` or `git add .` — both checkouts are full of unrelated
   modified/untracked files and a blanket add will sweep in someone else's work
   or scratch state.
2. **Never force-push `singulance-main`.** No `git push --force`, no
   `git push --force-with-lease` to the shared branch. If your push is rejected,
   **pull/rebase and re-push** — a force-push silently deletes commits another
   agent just pushed. This is the #1 way to overwrite each other.
3. **Pull before you branch off, rebase before you push.**
   `git fetch origin singulance-main && git rebase origin/singulance-main`. Land
   on top of what's already there; do not merge stale history over new commits.
4. **Push, then deploy — and one deployer at a time.** Commit → push to
   `singulance-main` → then `quick-deploy.sh`. Make sure no one else is
   mid-deploy: two deploys race on the shared `:latest`/`:stable` tags and can
   leave a service on a half-built image or an untrustworthy rollback. Announce
   the deploy; run it; announce done.
5. **Correct author, always.**
   `git -c user.name=amarsai3012005 -c user.email=amarsai3012005@users.noreply.github.com commit`.
6. **Coordinate on shared files.** If both agents touch `core/src` (ingestion,
   recall, chat) at the same time, land one, deploy+verify it, then rebase the
   other on top. Do not push two independent rewrites of the same module and
   hope git merges them.
7. **Verify before you declare done.** Run the checks in [SHIPPING.md](SHIPPING.md).
   For memory/recall/ingestion changes, run the recall eval and baseline any
   suspected regression against `:stable` before keeping the change live.

## The standard handoff (Codex → box)

```
Codex (localhost)                          Claude (box)
─────────────────                          ────────────
1. git fetch origin singulance-main
2. git rebase origin/singulance-main
3. stage ONLY your files (explicit paths)
4. commit (correct author)
5. run local tests / node --check
6. git push origin singulance-main   ─────►  7. bash /root/quick-deploy.sh singulance-main
                                             8. health + smoke + (recall eval if memory touched)
                                             9. announce: deployed <sha>, or rolled back
```

If two change-sets are in flight, **push and deploy them one at a time**, verify
each, and rebase the next on top. Never bundle an unverified second change into
the same deploy.

## Pulling this folder

This `SINGULANCE-ONBOARD/` folder is committed on `singulance-main`. Any agent or
human can `git pull` it and read it before touching production. Keep it truthful:
update it when a durable operational rule or verified production fact changes —
not as a second implementation spec. Detailed implementation lives next to the
code.

## What each side must NEVER do

| Actor | Never |
| --- | --- |
| Box (Claude) | Build/pull/reset `/root/hivemind` (the dirty scratch). Author features on the box and expect them to survive a deploy. Deploy while another deploy is running. |
| Localhost (Codex) | Force-push `singulance-main`. `git add -A`. Push over a rejected push without rebasing. Claim prod has code that is only local. |
| Both | Delete PostgreSQL/Qdrant/Redis or customer volumes. Commit secrets. Report green without verifying. Overwrite `:stable` before confirming the new `:latest` is healthy. |
