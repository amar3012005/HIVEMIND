---
name: hyperagents-builder
description: AUTO-USE for ANY work on HIVEMIND HyperAgents / Digital-Employees rooms — building, extending, debugging, shipping, or explaining the multi-agent room pipeline (PLAN→GATHER→RECON-PRE→EXECUTE→SIMULATE→PRODUCE→RECON-POST→GOALKEEPER), the Python sidecar orchestrator `api_hyper_rooms.py`, agent prompts/personas, the control-plane turn/room routes + SSE, the React room UI (HyperAgents.jsx), connectors (Gmail/Docs/Sheets/Drive/MCP) inside rooms, recall/memory grounding, write-approval gates, or anything touching hyper-rooms turns, owners/assignments, convergence, or the swarm. Invoke this BEFORE touching any HyperAgents code or answering any HyperAgents question.
---

# HyperAgents Builder — dev harness & pipeline

This skill makes HyperAgents development smooth, certain, and bug-free. It owns a
mandatory workflow and three living docs. **On invocation, FIRST load context, then
follow the pipeline — do not freelance.**

## STEP 0 — Load context (every time, before anything else)

Read, in order:
1. `.claude/hyperagents/CONTEXT.md` — topology, file map, the 8-phase pipeline, deploy, test harness, lessons, key IDs.
2. `.claude/hyperagents/JOURNAL.md` — what already shipped (newest-first). **This is how you avoid rebuilding existing features.**
3. `.claude/hyperagents/TODO.md` — any in-flight phases.

Then announce: "Using hyperagents-builder — loaded context, JOURNAL has N entries, TODO is <idle|feature X at phase Y>."

## Completion contract (scoped goal-loop — drive to the end, but bounded)

Once a task is planned, **drive it to completion without yielding** — do not stop
half-done. BUT this is bounded, not blind persistence:
- **Stop = verified working on the box** (e2e per CONTEXT.md), shipped, journaled. That is "done."
- **Honest-exit:** if blocked on a decision only the user can make (which address? which of two products? is this the intended scope?), STOP and surface it — do NOT thrash. Asking the human is success, not failure. (The Ethan turn was right to stop, not loop 4 rounds.)
- **Bounded:** if a single phase fails its verify 3× for the same reason, STOP and report the blocker with evidence — never loop indefinitely.
This mirrors the runtime goalkeeper: rework toward success, cap the retries, fail honest.
(Blanket `/goal` on every task is the anti-pattern — it thrashes on ambiguous conditions.)

## The mandatory pipeline (NO workflows — agents only; workflows are expensive)

When the user asks for ANY HyperAgents change, run these phases **in order**, as
inline work + cheap subagents (`Agent` tool). Create a TODO item per phase.

### 1. RECON-REDTEAM  (a single `cartographer` or `bug-hunter`/`skeptic` agent — NOT a Workflow)
Dispatch ONE agent to: map the exact code surface for the change (functions + line
anchors) AND red-team the idea — "does this already exist? will it break? is it
patchwork vs a real fix? what's the blast radius?" Cheap, single pass.
> **Verify its output against ground truth.** Recon agents and code-review-graph go
> STALE (a cartographer once claimed shipped functions didn't exist). Before trusting
> any "X is absent" claim, confirm with `grep`/`Read` yourself. CONTEXT.md § lessons.

### 2. FEATURE-RECON  (before EVERY plan — anti-duplication gate)
Search for prior art so we never rebuild/rewrite: grep the target files for the
symbols, scan JOURNAL.md for a matching ship, and (optionally) invoke the
`feature-recon` skill. If it already exists and is wired → **HALT and extend, don't
rebuild.** Report "exists, extend X" or "net-new, safe to build."

### 3. PLAN  → write phases to TODO.md
Restate the goal + the recon-redteam verdict + feature-recon finding, then break the
work into ordered, verifiable phases. Write them into `.claude/hyperagents/TODO.md`
(replace the "Current feature" block). Each phase: files touched + a done-when check.

### 4. EXECUTE  (one phase at a time)
Implement phase 1, mark `[~]`→`[x]` in TODO.md, then the next. Surgical edits;
match surrounding code. Compile/parse-check after each (`python -m py_compile`,
FE `npm run build`). Never batch-jump phases.

### 5. VERIFY  (on the box, real)
e2e per CONTEXT.md test harness — fire a direct sidecar room-turn, watch the phase
logs, assert the verification verdict. Test email recipient = `amarsai2005@gmail.com`.
A change isn't done until observed working.

### 6. SHIP  → then JOURNAL.md (always, immediately)
Commit (author `amarsai3012005 <amarsai3012005@users.noreply.github.com>`, stage only
changed files), push (`main` = PROD; FE = Da-vinci submodule then bump pointer),
deploy per CONTEXT.md (`docker cp` + restart `hm-employees` / both `hm-core hm-core-2`).
**Immediately append a JOURNAL.md entry** (commits, what, why, files, verified, gotchas)
and clear the TODO "Current feature" block. This is non-negotiable — the journal is how
the next session/device inherits what happened.

### 7. RETROSPECTIVE  (lightweight meta-pass after every ship — PROPOSE, never auto-apply)
A single cheap agent scores the run JUST completed and proposes harness improvements.
**It does not silently rewrite anything** — auto-rewriting your own instructions drifts
and reward-hacks the score. It writes a diff/suggestion; you (or the user) approve.
- **Score the run** (1 line each): did RECON-REDTEAM hold against ground truth, or was it stale? did FEATURE-RECON catch prior art (or did we almost rebuild)? did VERIFY pass first try or after N reworks? wasted rounds / wrong turns? Put this scorecard in the JOURNAL entry.
- **Delegate distillation to the `hivemind-skill-evolver` skill** — it owns the verified-only observe→verify→distill→refine loop + the instinct/skill substrate. Do NOT build a parallel scorer. It learns ONLY from verified runs (gate: committed+pushed+verified+not-user-corrected).
- **Propose, gate, version:** any CONTEXT.md / SKILL.md change is an additive lesson by default (a new gotcha, a sharper anchor); a structural rewrite is proposed as a diff for human approval. Everything is in git → reversible. If the lesson is just "this already worked," change nothing.
- Goal of the score: measurable next-run improvement (recon held, fewer rework rounds), not wording churn. If a proposed rewrite can't name the failure it prevents, drop it.

## Explaining to a new session / device / person

Point them at `.claude/hyperagents/CONTEXT.md` (orientation) + `JOURNAL.md` (history).
Those two + this skill are self-contained: a cold session on a new machine `git pull`s
the repo, this skill auto-triggers on any HyperAgents mention, loads both, and is
immediately productive. To brief a human: summarize CONTEXT.md § pipeline + the latest
2-3 JOURNAL entries.

## Keep the harness current (recursive self-upgrade)

This skill and its docs evolve WITH the subsystem. Whenever you touch HyperAgents:
- New phase/function/route/event-type → update `CONTEXT.md` (file map, pipeline table, gotchas).
- New ship → `JOURNAL.md` entry (step 6, mandatory).
- New recurring failure → add to CONTEXT.md § lessons.
- The pipeline or deploy changed → fix it HERE so the next session inherits the truth, not a stale memory.

Cross-ref: HIVEMIND-wide context = `hivemind-apex` skill; FE design = `hivemind-frontend`.
Do NOT spin up a Workflow for HyperAgents work — the user pays per agent; this skill's
single-agent recon + inline execute is the deliberate, cheaper path.
