# HIVEMIND — Claude Code onboarding

This `.claude/` is tuned to run Claude Code at high speed on HIVEMIND: **recon before building, reuse over rebuild, verify before shipping.** New contributor? Read this once.

## Golden loop
1. **Recon first** — never build blind. `/feature-recon "<the feature>"` (skill) or the `feature-recon` **workflow** (parallel graph + git + HIVEMIND-memory → reuse/extend/build verdict). A partial hit turns "build" into "extend". This is the #1 time saver.
2. **Build** — follow existing patterns; `hivemind-dev` skill has the add-feature / fix-bug / refactor flows. Backend is ESM Node/Express/Prisma in `core/`; FE is the `Da-vinci` submodule (CRA + Tailwind, see the `hivemind-frontend` skill for tokens).
3. **Review** — run the `review-changes` workflow on your diff (bugs / tenant-isolation / perf / db-migration / standards, each skeptic-verified) before you commit.
4. **Ship** — the `ship` skill: commit (correct author) → push → pull on prod → migrate → restart hm-core → smoke + recall-eval. Then the `deploy-verify` workflow confirms the box is in sync + healthy + un-regressed.

> **Current production exception (2026-07-09):** the active deployment is Singulance Compose,
> not the legacy `myserver` flow above. Before any production operation read
> `.claude/MEMORY.md` "Singulance production topology" and use its build, rollback, and
> `--env-file /root/hivemind/.env` rules.

## Curated assets
- **Skills** (`.claude/skills/`): `feature-recon`, `hivemind-dev`, `ship`, `hetzner-ops`, `qdrant-ops`, `mcp-integration`, `debug-issue`, `refactor-safely`, `review-changes`, `explore-codebase`. Global also: `hivemind-apex` (full repo manual + fix playbook), `hivemind-frontend`, `hermes-agents-builder`.
- **Workflows** (`.claude/workflows/`, invoke via the Workflow tool by `name`): `feature-recon`, `review-changes`, `deploy-verify`.
- **`.claude/scripts/hm`** (maintainer-only): prod ops dispatcher — `hm status|logs|sync|smoke|eval|psql` (read-only) and `hm deploy|restart|migrate` (DRY-RUN unless `--confirm`; `deploy` bakes in the box-patch hazard handling + migrate gate + post-deploy smoke/eval). Needs the `myserver` SSH alias + `HM_MASTER_KEY`. Contributors don't use this — it drives production.
- **Agents** (`.claude/agents/`): `HIVEMIND-APEX` (surgical fixer), `cartographer` (blast radius), `historian` (why is it like this), `implementer-backend|frontend|infra`, `code-reviewer`, `security-reviewer`, `db-reviewer`, `deploy-operator`, `e2e-runner`, `mcp-specialist`, `nango-specialist`, `memory-curator`, … fan out for parallel independent work.
- **CLAUDE.md** (repo root) — graph-first + HIVEMIND memory-discipline rules, loaded every session.

## Memory discipline (this repo persists across sessions)
- Bootstrap recall at session start (CLAUDE.md has the exact calls).
- After meaningful work: `hivemind_log_decision` / `hivemind_save_memory` (tagged `session-trail-<date>`), `hivemind_ingest_code` after real edits.
- Before touching unfamiliar/known-buggy code: `hivemind_why_code` / `hivemind_recall_bugs`.

## Local dev — do NOT use the prod box
- Bring up the stack locally: `docker-compose.local-stack.yml` (Postgres + Qdrant + Redis + core). Copy `.env.example` → `.env` with **dev-only** keys + **synthetic** seed data. Never a prod dump (GDPR).
- `myserver` is **production** (live `hm-core`, real customer data, master key, OAuth/Nango secrets). Contributors never get SSH to it and never see prod secrets.
- Workflow for contributors: **feature branch → PR against `main` → review + CI green → a maintainer deploys.** No direct push to `main`, no deploy rights, scoped (non-master) API key only.

## Invariants
- Commit author: `amarsai3012005 <amarsai3012005@users.noreply.github.com>`.
- Stage explicit paths only (the tree has unrelated modified files) — never `git add -A`.
- ESM everywhere (`"type": "module"`). Backward-compatible migrations with a down path. Tenant-scope every query. No secrets in source.
