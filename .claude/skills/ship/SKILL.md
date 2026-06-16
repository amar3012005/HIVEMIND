---
name: ship
description: Ship a HIVEMIND change end-to-end — commit (correct author) → push → pull on prod → migrate → restart hm-core → wait ready → smoke + recall-eval gate, plus the frontend Da-vinci → Vercel + submodule-bump path. Encodes every deploy gotcha that recurs (staged-uncommitted blocking pull, untracked-file blocking pull, single-replica restart, migrate-before-node gate, PartOf cluster, recall-eval regression). Triggers — "ship it", "deploy", "push to prod", "release", or any time a verified change needs to reach production.
---

# ship

Get a verified change to production **durably and safely**. The box (`myserver`, Hetzner `116.202.24.69`) bind-mounts `/opt/HIVEMIND/core → /app` of `hm-core`, so prod runs whatever is in git on the box. **Single-replica topology** (hm-core only; hm-core-2 retired). Run [feature-recon](../feature-recon) before building and [review-changes] before shipping.

**Announce:** "Using ship to deploy <change>."

## Invariants (never deviate)
- **Commit author MUST be** `amarsai3012005 <amarsai3012005@users.noreply.github.com>`:
  `git -c user.name=amarsai3012005 -c user.email=amarsai3012005@users.noreply.github.com commit -m "…"`
- **Stage only your files** — `git add <explicit paths>`. The worktree has many unrelated modified/untracked files; never `git add -A`.
- **Conventional commit** type: `feat|fix|refactor|docs|test|chore|perf|ci`.
- **Never** `git push --force`, `git reset --hard origin`, or destructive infra ops without explicit user confirm.
- **Never** hardcode the master key in a committed file; read it from env / the hivemind-apex skill.

## Backend flow (core/* → hm-core)

```bash
# 1. Commit only your files (correct author)
cd /Users/amar/HIVE-MIND && git add core/src/<files> core/prisma/<migration>
git -c user.name=amarsai3012005 -c user.email=amarsai3012005@users.noreply.github.com \
    commit -m "feat(scope): summary"
git push origin main

# 2. Pull on the box — SEE "Pull hazards" below; this is where deploys break
ssh myserver "cd /opt/HIVEMIND && git pull origin main 2>&1 | tail -6 && echo HEAD=\$(git rev-parse --short HEAD)"

# 3. If a migration was added, APPLY IT BEFORE restart (the launcher chains
#    `prisma migrate deploy && node src/server.js` — a failed migrate = no boot)
ssh myserver "docker exec hm-core npx prisma migrate deploy 2>&1 | tail -12"

# 4. Restart (single replica) + wait ready
ssh myserver "docker restart hm-core >/dev/null 2>&1 && echo restarted"
for i in $(seq 1 30); do ssh myserver "docker exec hm-core node -e 'process.exit(0)' 2>/dev/null" && break; sleep 2; done

# 5. Boot check (filter the redis ENOTFOUND noise)
ssh myserver "docker logs hm-core --since 60s 2>&1 | grep -iE 'listening|error|SyntaxError|cannot find' | grep -viE 'redis|getaddr|ENOTFOUND' | tail -12"
```

Then **verify**: run the `deploy-verify` workflow (box-sync + health + smoke + recall-eval) or do it inline. Recall baseline: **combo@8 = 1.00, MRR ≈ 0.87** — a regression means stop and investigate.

### Pull hazards (the #1 cause of "deploy didn't take")
The box accumulates local state that blocks `git pull`. Diagnose, don't force.

| Symptom on `git pull` | Cause | Fix |
|---|---|---|
| `Your local changes to … would be overwritten` | Box has **staged/uncommitted** edits (a prior session `git add`-ed without committing) — usually already superseded by origin | Confirm superseded: `git -C /opt/HIVEMIND diff <origin-sha> -- <file>` shows only the OLD lines. Then `git checkout HEAD -- <file>` (restores from **HEAD/index**, clearing staged) and re-pull. Back up first: `git diff <file> > /opt/HIVEMIND/.pull-bak/x.patch` |
| `untracked working tree files would be overwritten` | A box-only scratch file shares a path an incoming commit adds | `mkdir -p /opt/HIVEMIND/.pull-bak && mv <file> .pull-bak/` then pull |
| Pull "succeeds" but HEAD unchanged | The pull aborted earlier in the `&&` chain | Re-run pull alone; read the real error |

`git checkout -- <file>` restores from the **index** (keeps staged changes) — use `git checkout HEAD -- <file>` to blow away staged too. This distinction has eaten multiple cycles.

## Frontend flow (frontend/Da-vinci → Vercel)
Da-vinci is a submodule that deploys via **Vercel** on push (it has `vercel.json` — NOT Coolify). Two commits: the submodule, then the pointer bump.

```bash
# 1. Commit in the submodule (correct author), push its main
cd /Users/amar/HIVE-MIND/frontend/Da-vinci && git add <files>
git -c user.name=amarsai3012005 -c user.email=amarsai3012005@users.noreply.github.com commit -m "feat(scope): …"
git push origin HEAD            # ensure on main: git rev-parse --abbrev-ref HEAD

# 2. Bump the submodule pointer in the superproject
cd /Users/amar/HIVE-MIND && git add frontend/Da-vinci
git -c user.name=amarsai3012005 -c user.email=amarsai3012005@users.noreply.github.com commit -m "chore(submodule): bump Da-vinci → <sha>"
git push origin main
```
Vercel auto-builds on the Da-vinci push. **Lint before pushing**: `cd frontend/Da-vinci && npx eslint <changed file>` (exit 0). You can't confirm the Vercel build from here — say so; the user checks the dashboard.

## Verify checklist (before declaring done)
- [ ] `node --check` on every edited backend `.js`; eslint clean on edited FE files.
- [ ] Box HEAD == origin/main (the change actually landed).
- [ ] hm-core `Up`, listening, no import errors in logs.
- [ ] Smoke the touched endpoint live (in-container curl, master key + test headers).
- [ ] Recall eval not regressed (if memory/recall touched).
- [ ] Report commit SHAs + what was verified. State plainly what you could NOT verify (e.g. Vercel build).

## Gotchas catalogue (HIVEMIND-specific, learned the hard way)
- **memories table has NO json `metadata` column** — metadata lives in related `source_metadata`/`code_metadata` tables. To walk a parent→children cluster (e.g. meeting insight clusters) use the **`relationships` PartOf edge**: `SELECT from_id FROM relationships WHERE to_id = <parent> AND type = 'PartOf'`. Querying `metadata->>'parent_memory_id'` throws `column "metadata" does not exist`.
- **Engine scope guards** (`graph-engine` `_buildMemoryRecord`): project scope REQUIRES `project_ids`; team scope REQUIRES `primary_team_id` — else it throws. Degrade gracefully (project-without-id → personal; team-without-team → organization).
- **`replace_all` over a 2-line pattern can clobber an object literal** into a self-reference (`...x` inside `const x = {…}`) → ReferenceError TDZ. After a replace_all, re-read the edited region.
- **Silent catches**: don't ship a `catch` that returns a generic error with no `console.error` — you'll be blind on the box (prod hides the message). Log the stack.
- **Single replica**: only `hm-core`. Restart just it. Do not reintroduce hm-core-2 by hand.
- **Qdrant**: 1024-dim bge-m3, per-tenant `org_<id>` collections on the on-box `hm-qdrant`. Hard-deletes must purge Qdrant points too.

## When NOT to use
Local-only experiments, doc-only edits that don't need prod, or anything the user hasn't asked to deploy. Committing/pushing/deploying is an explicit, durable action — do it when shipping is the task, not speculatively.
