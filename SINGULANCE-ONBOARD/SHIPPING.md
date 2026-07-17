# Shipping — quick, safe, rollbackable

The whole point of this model: **ship a feature in one command, roll it back in
one command, and never overwrite anyone's work.** Read [COLLABORATION.md](COLLABORATION.md)
before you push if another agent (Codex, another Claude) might also be working.

## The golden path

```bash
# From your dev machine / local checkout: push your feature to the ONE branch.
git push origin singulance-main

# On the box (root@singulancelabs.com): pull + build-changed + run :latest.
bash /root/quick-deploy.sh singulance-main
```

That single script does everything:

1. `git fetch origin singulance-main` and force-checks-out its tip into the
   build source `/root/hivemind-next` (discards box-local drift → live == git).
2. Diffs `/root/.quickdeploy-last-sha` (last deployed) against the new tip and
   selects **only the services whose files changed**.
3. If PREV is missing/unknown → rebuilds **all** services (safe, just slower).
4. Applies any new DB migrations (backup first, idempotent SQL) before recreate.
5. For each changed service: retags the current `:latest` → `:stable`
   (rollback), builds the new `:latest`, recreates only that container, and
   waits for it to become healthy.
6. Runs the public smoke (`singulancelabs.com`, `next…/hivemind`,
   `api…/health`, `core…/health`) and records the new SHA in
   `/root/.quickdeploy-last-sha`.

Idempotent: re-running when live already equals the tip prints
`already at <sha> — nothing to deploy` and does nothing. You do **not** need to
rebuild every time.

### Which service rebuilds for which change

| Files changed | Service rebuilt | Container |
| --- | --- | --- |
| `core/src/control-plane-server.js`, `core/src/outreach`, `core/src/security`, `core/src/billing` | control-plane | `hm-control` |
| `core/src`, `core/prisma` | core | `hm-core` |
| `employees-service` | employees | `hm-employees` |
| `services/tara-aaas`, `services/tara-deepgram` | tara-deepgram | `tara-deepgram` |
| `frontend/Da-vinci` | fe | `hivemind-next-frontend-1` |

## Rollback (one command)

Each service keeps exactly one previous image as `:stable`. To revert:

```bash
bash /root/quick-deploy.sh --rollback <service>      # e.g. core, control-plane, employees, fe
```

This retags `:stable` → `:latest`, recreates the container, and health-gates it.
`:stable` is **saved, never run as a second container**, and is overwritten on
the next successful deploy — so it is always precisely the last-known-good.

## Verify before you call it done

- [ ] `node --check` on every edited backend `.js`; lint clean on edited FE files.
- [ ] `/root/.quickdeploy-last-sha` == `git -C /root/hivemind-next rev-parse HEAD`
      (the change actually landed).
- [ ] Target container `Up (healthy)`, no import errors in `docker logs`.
- [ ] Public smoke all `200`.
- [ ] If memory/recall/ingestion changed: run the recall eval and confirm no
      regression **before** declaring success —
      `docker exec hm-core node /app/scripts/eval-harness.mjs`. Baseline a
      suspected regression against `core-api:stable` before deciding keep vs roll
      back. Never report green you have not seen.
- [ ] State plainly what you could NOT verify (e.g. the Vercel FE build, which is
      confirmed from the Vercel dashboard, not the box).

## Hard rules (never deviate)

- **Commit author MUST be** `amarsai3012005 <amarsai3012005@users.noreply.github.com>`:
  `git -c user.name=amarsai3012005 -c user.email=amarsai3012005@users.noreply.github.com commit -m "…"`.
- **Stage only your files** — `git add <explicit paths>`. Both checkouts carry
  unrelated modified/untracked files; **never `git add -A` / `git add .`**.
- **Conventional commit** type: `feat|fix|refactor|docs|test|chore|perf|ci`.
- **Never** `git push --force`, `git reset --hard origin`, or destructive infra
  ops without explicit human confirmation.
- **Never** commit secrets (master key, session secret, connector tokens). They
  are provided at runtime via `/root/hivemind/.env`, never baked into an image.
- **Push before you deploy, and one deployer at a time** — see
  [COLLABORATION.md](COLLABORATION.md). Unpushed commits on the box are wiped by
  the next deploy's force-checkout.
