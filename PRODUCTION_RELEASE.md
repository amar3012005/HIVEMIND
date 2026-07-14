# SINGULANCE Production Release Ledger

## prod-20260714-68d67a39 — Room METHOD skills + one-company isolation + report depth
- **Date:** 2026-07-14
- **Parent:** branch `feat/room-skills-prod`, SHA `68d67a39caa8f0868cd25d41f90e815a5d32f251`
- **Frontend:** branch `feat/room-skills-prod` (Da-vinci), SHA `d15c81434634c766898db4622f463e9434c40390`
- **Base:** `codex/production-hardening-runtime` @ `fd90e579` + cherry-picks `796cc4b2` (one-company-per-org replace, report-quality synth/debate fixes) and `aec5b47f` (room METHOD skills + self-evolving room playbook; task_tag plumbing adapted out for this line)

### Images (built from clean detached worktree /root/builds/prod-20260714-68d67a39)
| Image | ID | Origin |
|---|---|---|
| hivemind/employees:prod-20260714-68d67a39 | 7eb9773d69e7 | built |
| hivemind/control-plane:prod-20260714-68d67a39 | eed07c5f1622 | built |
| hivemind/fe:prod-20260714-68d67a39-single | 9754bba9934e | built |
| hivemind/core-api:prod-20260714-68d67a39 | bb54067c4e8e | retag of prod-20260714-8f049395 (unchanged) |
| hivemind/tara-deepgram:prod-20260714-68d67a39 | f7e92ff68a9b | retag (unchanged) |
| hivemind/byod-broker:prod-20260714-68d67a39 | ae0fe36a8468 | retag of next-2d879e77 (unchanged) |
| hivemind/hm-playwright:prod-20260714-68d67a39 | 4177c43a4414 | retag of latest (unchanged) |

### Migrations
- `20260714150000_room_playbook` — `ALTER TABLE hivemind.hyper_rooms ADD COLUMN IF NOT EXISTS room_playbook JSONB;` (additive; down = DROP COLUMN). Applied before promotion; verified column exists.
- PG backup: `/root/backups/backup-prod-20260714-68d67a39.dump` (16.7 MB, sha1 `a89357a7…`, .sha alongside).

### Runtime
- `/root/hivemind/.env` VERSION=prod-20260714-68d67a39 (backup `.env.bak-prod-20260714-68d67a39`)
- `/root/hivemind-next/.env.embedding-canary-runtime` NEXT_VERSION=prod-20260714-68d67a39 (backup alongside)
- Recreated one-at-a-time with health gates: hm-employees → hm-control → hivemind-next-frontend-1 (from `-single`). Data services untouched. hm-core/tara containers not recreated (code unchanged; tags provided for compose consistency).

### Acceptance evidence
- Public 200: singulancelabs.com, next.singulancelabs.com, /hivemind/login, api/health, core/health. TARA route 401 = expected privileged-agent gate; tara-deepgram container healthy.
- FE lazy chunk marker: `skill_used` present in `/srv/static/js/8174.fcf43b9e.chunk.js` (not main.js).
- Fresh fatal/panic/uncaught/OOM/migration errors: 0 (hm-employees, hm-control).
- Authenticated (disposable session, internal FOREST org owned by support@singulancelabs.com): `/v1/hyper/company` 200 onboarded.
- Feature e2e turn `58dff37d` (FOREST HQ): `skill_used=competitor-teardown` event emitted, 9 debate reacts, ZERO "(no reply)", seal=complete, deliverable follows ANALYTICAL DEPTH contract (Executive Summary + Key Insight + quantified actions).
- In-container skills registry: 6 kinds / 17 skills load; `resolve_room_kind("Research Competitor Landscape") → market`.
- Second e2e with evo on (turn `d8b6a6c2`): room-playbook learning path exercised (see addendum).

### Rollback
- Tags `rollback-20260714-133714` on employees/control-plane/fe-single; env backups above; DB backup above.
- Procedure: restore env backups → `docker compose … up -d --no-deps --force-recreate` affected services → (only if needed) `ALTER TABLE hivemind.hyper_rooms DROP COLUMN IF EXISTS room_playbook;`

### Intentionally untested external side effects
- No emails/calls placed. Reactor NEED protocol shipped flag-OFF (`HYPER_REACTOR_REACH`). Room-skills catalog ON by default (`HYPER_SKILLS_ENABLED`).
