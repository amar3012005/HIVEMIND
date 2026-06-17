---
description: Autonomous 4+-agent dev pipeline — recon→design→TDD→build→adversarial-review→E2E, parks at a human gate, then ships to prod on your go. Reuses the whole .claude harness.
argument-hint: <feature/intent, e.g. "rate-limit the login endpoint">
---

# /ship-feature

Run the full HIVEMIND dev pipeline for: **$ARGUMENTS**

This is the robust version of the "4 agents while you sleep" pattern. It does **everything except the irreversible merge** autonomously, then **blocks for your explicit "ship it"** before anything reaches `main` (on this repo `main` IS prod — single-replica bind-mount box).

## How it chains (one command, the whole team)

The agents hand off through a durable **`.pipeline/<slug>/`** artifact bus (one numbered JSON per stage + a `manifest.json` resume cursor). Each stage reads only the prior artifact — explicit contract, no hidden coupling — and the folder survives context-compaction so a cold session can resume from `manifest.current_stage`.

Depth is **tier-gated** (set by stage 0): `TRIVIAL` skips recon/design/plan/TDD/E2E; `STANDARD` runs the lane minus heavy adversarial stages; `RISK` (auth · OAuth/Nango · Prisma migration · tenant-scope · payments · deploy/infra · recall path) runs the full chain with every adversarial lane mandatory.

| # | Stage | Agent / workflow | Model | Gate |
|---|---|---|---|---|
| 0 | Triage & tier | `cartographer` (impact probe) | haiku | fail-UP; any security/db/infra/recall surface → ≥STANDARD |
| 1 | Recon (reuse-or-build) | `feature-recon` workflow | — | **GATE A**: exists+wired-live → HALT "reuse, don't rebuild" |
| 2 | Design (+ threat model) | `architect` ‖ `threat-modeler` | opus | unmitigatable threat → HALT |
| 3 | Plan (atomic DAG) | `planner` | sonnet | server.js tasks serialized; every DB task up+down |
| 4 | TDD **RED** | `tdd-writer` | sonnet | tests MUST fail for the right reason (max 2) |
| 5 | **GREEN** implement | `implementer-*` | sonnet | per-task `node --check`; monolith edits serialized |
| 6 | Adversarial review ↻ | `review-changes` workflow | opus | confirmed crit/high → loop to 5 (max 2); **tenant leak = immediate HALT** |
| 7 | Local E2E + perf | `e2e-runner` (+`performance-critic`) | sonnet | flow fail / perf regress → one fix round |
| — | **Dossier** | (workflow returns) | — | **parks here — nothing shipped** |

Then, in THIS conversation (where a human gate is possible):

| 8 | **HUMAN SHIP GATE** | you | — | **GATE C**: blocking, no auto-approve, every run |
| 9 | Ship to prod | `ship` skill via `hm deploy --confirm` | — | refuses unless you approved; migrate-before-node; box HEAD==origin/main |
| 10 | Post-deploy verify | `deploy-verify` workflow | — | recall regression / unhealthy → **rollback to last-known-good** |
| 11 | Memory + journal | `memory-curator` + `journal-keeper` | haiku | always runs (records halts too) |

## What to do when this command runs

1. **Invoke the workflow** (stages 0–8) and wait for it (`.claude/workflows/*.js` are not name-registered — use `scriptPath`):
   `Workflow({ scriptPath: "/Users/amar/HIVE-MIND/.claude/workflows/ship-feature.js", args: "$ARGUMENTS" })`

2. **On `status: "halted_awaiting_human"`** — do NOT proceed. Surface `halt_reason` + the `.pipeline/<slug>/` trail, leave the worktree/diff intact, and ask the user how to proceed (the common case is GATE A: "already exists, reuse X").

3. **On `status: "awaiting_human_ship_gate"`** — present the `dossier` as a one-screen summary: recon verdict, tier, `files_changed`, `confirmed_review` (must be zero crit/high), threats, E2E result, rollback order. Then **GATE C — block for an explicit "ship it"** (use AskUserQuestion if unsure). Never infer approval.

4. **On approval** — ship via the **`ship` skill** (commit with author `amarsai3012005`, stage only the changed files, push, `hm deploy --confirm`), then run the **`deploy-verify`** workflow, then close out memory (`memory-curator` + `journal-keeper`, master-index tagged `session-trail-<date>`+`master-index`). On a verify regression, roll back to last-known-good before anything else.

5. **On rejection** — HALT, leave everything intact, write the reason into `.pipeline/<slug>/09-decision.json`.

## Invariants (never deviate — same as the `ship` skill)
- Commit author MUST be `amarsai3012005 <amarsai3012005@users.noreply.github.com>`.
- Stage only the feature's files — **never `git add -A`** (the worktree has unrelated dirty files).
- **Never** auto-merge to `main` / auto-deploy without the GATE C approval. `main` is prod.
- A confirmed **tenant-isolation/authz** finding and a **recall-eval regression** are stop-the-line — they bypass the retry budget and HALT to a human.
- The only autonomous mutation past the gate is **rollback-to-last-known-good** on a RED post-deploy verify.

## Resume
`.pipeline/<slug>/manifest.json` is the single source of truth. To resume a parked/crashed run, read it for `current_stage` + `status`, or re-run the workflow with `Workflow({ resumeFromRunId, scriptPath })` (cached stages return instantly).
