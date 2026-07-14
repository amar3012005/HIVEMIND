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

## prod-20260714-d9dfcfe7 — Grounding verification gate + log hygiene + provenance fix
- **Date:** 2026-07-14
- **Parent:** branch `fix/grounding-verifier-hardening`, SHA `d9dfcfe7f0d6d43f9ef27bb0cd3616d8e2190d54` (off `feat/room-skills-prod` @95fce4ba)
- **Frontend:** unchanged, gitlink `d15c81434634c766898db4622f463e9434c40390`
- **Fixes the prod-20260714-68d67a39 acceptance findings:**
  1. Deterministic company-grounding gate: company-scoped turn with missing company brief → grounded_ok=false + met=false + gap (code-enforced, not LLM-trusted); canonical-name substitution likewise blocked (db.get_company_name from persisted _company). Orchestrator retries the brief once (12s) and emits a `company_context_missing` warning event.
  2. Verifier chain-of-thought no longer logged: `AGENTSCOPE_DISABLE_CONSOLE_OUTPUT` defaults true in the sidecar (main.py, set before agent imports). Structured verdict log lines only.
  3. Runtime provenance: ALL app services recreated under the immutable tag — hm-employees/hm-control/hm-core/tara-deepgram/next-frontend all display prod-20260714-d9dfcfe7 (unchanged services = retagged verified digests: core-api bb54067c4e8e, tara f7e92ff68a9b, fe 9754bba9934e; employees rebuilt = sha256:1f1d22d6…).
  4. Migration provability: new `hivemind.schema_migrations_applied` ops ledger table; row for `20260714150000_room_playbook` (sha1 8c6f2cad…, release prod-20260714-68d67a39).
- **Tests:** 5/5 deterministic-gate regression tests (missing-context force-fail, name-substitution block, healthy pass, non-company task unaffected); ast green.
- **Acceptance evidence:** public 200 ×4; turn `817301e5` on FOREST org (canonical company = "Formula 1"): brief recalled 431 chars, verifier returned grounded=false with gap "deliverable never references the company's canonical name (Formula 1) — possible identity substitution", goalkeeper re-round also refused → seal status **escalated** (NOT complete) — the exact blocking behavior required; `(thinking)` occurrences in logs since deploy: 0; fresh fatal/panic/uncaught/OOM: 0 (prior count was a grep false-positive: `-i OOM` matches inside `room=`).
- **Rollback:** tags `rollback-20260714-142631` (all five services) + env backups `.bak-prod-20260714-d9dfcfe7` + DB backup from prior release (no schema change in this release).
- **Untested side effects:** none — no emails/calls; internal test org only.
