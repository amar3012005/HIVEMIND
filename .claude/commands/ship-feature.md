---
description: Autonomous 4+-agent dev pipeline — recon→design→TDD→build→adversarial-review→E2E, parks at a human gate, then ships to prod on your go. Agent fan-out only (no Workflow tool — blocked in this env).
argument-hint: <feature/intent, e.g. "rate-limit the login endpoint">
---

# /ship-feature

Run the full HIVEMIND dev pipeline for: **$ARGUMENTS**

No Workflow tool. Each stage = one or more `Agent` calls (or `Skill` invocations).
The durable `.pipeline/<slug>/` artifact bus survives compaction — agents write numbered JSON per stage.

---

## Stage 0 — Triage (Agent: cartographer, haiku)

Spawn one `Agent` (agentType=`cartographer`, model=`haiku`):

> "Repo /Users/amar/HIVE-MIND. Classify this change for a tiered pipeline. Intent: `$ARGUMENTS`.
> Use code-review-graph MCP (get_impact_radius / semantic_search_nodes) for one cheap blast-radius probe.
> Produce:
> - slug: kebab-case of the intent (≤48 chars)
> - tier: TRIVIAL (doc/copy/const, zero risk) | STANDARD (≤3 files, no auth/db/recall) | RISK (auth, OAuth/Nango, Prisma migration, tenant-scope, payments, infra, recall path)
> - surfaces: {security, db, fe, infra, recall} booleans
> - blast_radius: one sentence
> RULE: any security|db|infra|recall surface = at least STANDARD. When unsure, fail UP.
> Write result to /Users/amar/HIVE-MIND/.pipeline/<slug>/00-triage.json and create manifest.json."

**GATE (code):** If tier=RISK and surfaces contain security|tenant → mandatory threat-model in Stage 2.

---

## Stage 1 — Recon (Skill: feature-recon)

Invoke the `feature-recon` skill with args = `$ARGUMENTS`.

**GATE A:** If verdict=`exists` AND wired=live → HALT. Surface the evidence. Ask user: reuse or override?
If verdict=`partial` → reframe task as "extend X". Note the gap delta.
If verdict=`missing` → confirmed greenfield, continue.

Skip for tier=TRIVIAL.

---

## Stage 2 — Design + Threat (parallel Agents for RISK tier)

For STANDARD/RISK: spawn `Agent` (agentType=`architect`, model=`opus`):

> "Repo /Users/amar/HIVE-MIND. Design implementation for: `$ARGUMENTS`.
> Recon: <paste verdict from Stage 1>.
> Produce: interfaces, module boundaries, schema delta, UP+DOWN migration shape if DB touched.
> server.js is a 20k-line monolith — extend, don't rewrite.
> Log decision via hivemind_log_decision.
> Write to .pipeline/<slug>/02-design.md and 02-design.json."

For RISK tier only, spawn concurrently `Agent` (agentType=`threat-modeler`, model=`opus`):

> "Repo /Users/amar/HIVE-MIND. Threat-model: `$ARGUMENTS`. Surfaces: <from triage>.
> Enumerate attack paths and TENANT-ISOLATION surface (every new query scoped by org_id/user_id).
> Output required_tests[] the TDD stage MUST cover — include a two-tenant isolation case.
> Flag unmitigatable_threat:true only if no safe design.
> Write to .pipeline/<slug>/02-threats.json."

**GATE:** If unmitigatable_threat=true in either → HALT immediately. Surface reason.

---

## Stage 3 — Plan (Agent: planner)

Spawn `Agent` (agentType=`planner`, model=`sonnet`):

> "Repo /Users/amar/HIVE-MIND. Decompose into atomic task DAG for: `$ARGUMENTS`.
> Design: <paste 02-design.json summary>.
> Each task ≤1 logical change: {id, summary, files[], deps[], parallel_safe, owner_agent}.
> CRITICAL: tasks touching server.js must NOT be parallel_safe (serialize monolith edits).
> Every DB task: UP + DOWN migration required.
> Write to .pipeline/<slug>/03-plan.json."

---

## Stage 4 — TDD RED (Agent: tdd-writer, max 2 attempts)

Spawn `Agent` (agentType=`tdd-writer`, model=`sonnet`):

> "Repo /Users/amar/HIVE-MIND. Write FAILING tests (RED) before implementation for: `$ARGUMENTS`.
> Tasks: <paste plan tasks>.
> Required coverage: happy path + boundary + failure + <threat-model required_tests if RISK>.
> If a tenant-scoped query is touched: include a two-tenant isolation test.
> Run tests — every new test MUST FAIL for the RIGHT reason (not import/syntax error).
> Report red_confirmed:true|false.
> Write to .pipeline/<slug>/04-red-report.json."

**GATE:** red_confirmed must be true within 2 attempts. On second fail → HALT.

Skip for tier=TRIVIAL.

---

## Stage 5 — Implement (parallel Agents per task)

For each task in the plan:
- Spawn `Agent` (agentType = task.owner_agent, model=`sonnet`)
- Serialize tasks where parallel_safe=false OR files contain server.js (run one at a time)
- Parallelize the rest in one batch

Per-task prompt:
> "Repo /Users/amar/HIVE-MIND. Implement task <id>: <summary>. Files: <files>.
> Write ONLY enough to turn RED tests GREEN — no speculative abstraction.
> After editing: run `node --check` on every edited .js.
> Match surrounding code style. NEVER git add -A.
> Call hivemind_ingest_code on each file you write.
> Write to .pipeline/<slug>/05-impl-<id>.json."

---

## Stage 6 — Adversarial Review (Skill: review-changes, bounded loop)

Invoke the `review-changes` skill on the current diff.

**Review → Implement loop (max 2 rounds):**
- confirmed critical|high findings → loop back to Stage 5 (fix only those findings)
- **TENANT-ISOLATION finding (any severity) → immediate HALT** — no retry budget

Break when zero critical|high confirmed findings.
On round 3 still blocking → HALT, surface findings.

---

## Stage 7 — Local E2E + perf pre-flight (Agent: e2e-runner, max 2 attempts)

Spawn `Agent` (agentType=`e2e-runner`, model=`sonnet`):

> "Repo /Users/amar/HIVE-MIND. Run local E2E + perf pre-flight for: `$ARGUMENTS`.
> Curl/Playwright the happy + error paths for touched endpoints LOCALLY (not prod).
> If recall path touched: check latency + eval harness has not regressed (combo@8≈1.00, MRR≈0.87).
> Report pass/fail per flow + any perf regression.
> Write to .pipeline/<slug>/08-e2e.json."

On fail: one fix round (re-run Stage 5 with e2e findings), then re-run E2E.
Second fail → HALT.

Skip for tier=TRIVIAL.

---

## GATE C — Human Ship Gate (mandatory, every run)

**BLOCK HERE. Do NOT proceed without explicit approval.**

Present the dossier:
- `tier` + `surfaces`
- `recon_verdict`
- `design_summary`
- `threats[]`
- `files_changed[]` (from plan tasks)
- `confirmed_review` (must be empty critical/high)
- `e2e` result
- `rollback_order` (from plan down_migration)
- Pipeline dir: `.pipeline/<slug>/`

**Wait for explicit "ship it" — never infer approval.**

---

## Stage 8 — Ship (Skill: ship)

On approval: invoke the `ship` skill.

Invariants (never deviate):
- Commit author: `amarsai3012005 <amarsai3012005@users.noreply.github.com>`
- Stage only feature files — `git add <explicit paths>` (worktree has unrelated dirty files)
- Conventional commit: `feat|fix|refactor|...`
- Never `git push --force`

---

## Stage 9 — Deploy Verify (Skill: deploy-verify)

Invoke `deploy-verify` skill immediately after ship.

Recall regression (combo@8 < 1.00) or unhealthy box → **rollback to last-known-good** before anything else.

---

## Stage 10 — Memory + Journal

Spawn two Agents in parallel:
- `Agent` (agentType=`memory-curator`): log decision + ingest changed files + master-index tagged `session-trail-<date>`+`master-index`
- `Agent` (agentType=`journal-keeper`): append to `.claude/hyperagents/JOURNAL.md`

---

## Invariants (never deviate)

- `main` IS prod — never auto-merge without GATE C
- Tenant-isolation or recall-eval regression = stop-the-line halt
- Rollback-to-last-known-good is the ONLY autonomous action past GATE C on a RED verify
- `.pipeline/<slug>/manifest.json` = resume cursor — read it to resume a crashed run
- If a stage can't verify (e.g. FE needs Vercel), say so explicitly — never claim success
