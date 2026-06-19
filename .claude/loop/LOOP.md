# Autonomous Goal Loop — protocol

The machinery that lets the agent work **one goal after another, unattended, for
long runs**, without faking success or losing the thread to context compaction.

## The five mechanisms (why it's robust, not one trick)

1. **Stopping is the exception.** The Stop hook (`.claude/hooks/goal-loop-stop.py`,
   wired in `settings.json`) blocks the turn from ending while any `[ ]`/`[~]` goal
   exists in `GOALS.md`, re-injecting the current goal. Resting state = "keep working."
2. **Fixed verify-before-ship pipeline per goal** (below). A stage never advances
   until the previous one proves itself. The **order is the safety property** —
   verify on the live box BEFORE `git push`, because push is what's "announced."
3. **State lives outside context** so compaction is survivable:
   - **git** — the durable record (one feature = one commit + push).
   - **`GOALS.md`** — the queue + cursor; resume mid-loop, never restart.
   - **`STATE.json`** — `iter` (runaway cap), `done_count` (progress reset),
     `last_shipped_sha` (dedup).
   - **memory** — `.claude/hyperagents/{CONTEXT,JOURNAL}.md` + HIVEMIND for the
     non-obvious facts a fresh session would waste an hour rediscovering.
4. **Idempotency + dedup** — re-running a step is safe. Don't re-ship an already-
   pushed commit (check `last_shipped_sha`); deploys are restart/`docker cp`
   (declarative); guard external sends against duplicates.
5. **Cheap honest verification at each step** — `py_compile`/`tsc --noEmit` before
   any deploy (typos die in seconds), live-endpoint smoke with real auth (proves
   the real thing answers, not a mock), screenshot/e2e for FE. On failure: fix +
   re-verify, never push through.

## Per-goal pipeline (the unit of work)

```
feature-recon (reuse > rebuild; grep ground-truth, don't trust stale graph)
  → plan (restate goal; bounded; write phases)
  → build (surgical edits, match surrounding code)
  → compile / typecheck (py_compile · tsc --noEmit)  ── gate
  → deploy (docker cp + restart the right container)
  → e2e VERIFY on the box (real endpoint / real data)  ── gate, BEFORE push
  → ship (commit author amarsai3012005; push; main = prod)
  → JOURNAL (append .claude/hyperagents/JOURNAL.md) + memory
  → mark the goal [x] in GOALS.md (move to Done with the sha) → next [ ]
```

## Rules (non-negotiable)

- **Verify before ship.** Never `git push` a goal whose live e2e hasn't passed.
- **Never fake success.** If e2e is red, fix or mark `[!]`; don't mark `[x]`.
- **Bounded goals only.** Each goal = small, complete, independently verifiable.
  Reuse existing machinery over net-new (cheaper, closes cleanly).
- **Stay in the loop, one decision per iteration** — pick the next goal, execute it
  fully, mark it, move on. No giant unverifiable pushes.
- **Human-stop on genuine ambiguity.** A real product decision only the user can
  make → mark the goal `[!]` with the reason and stop. Do NOT guess. (This is the
  honest caveat: the loop is only as good as its verification + your goals.)
- **Mark `[x]` only after shipped + verified.** That's what advances the loop.

## Controls

- **Start:** add goals to `GOALS.md`, say "run the loop" / `/loop`.
- **Pause:** `touch .claude/loop/PAUSE` (or mark the active goal `[!]`).
- **Resume:** `rm .claude/loop/PAUSE`, say continue.
- **Runaway guard:** `STATE.json.max_iter` (default 60) — consecutive Stop-blocks
  without a goal completing; hitting it pauses the loop. Resets on each `[x]`.
