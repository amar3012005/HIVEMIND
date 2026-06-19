---
description: Arm + run the autonomous goal loop — work .claude/loop/GOALS.md one goal at a time, verify-before-ship, until the queue is empty or a goal is blocked.
---

# Run the autonomous goal loop

Engine + protocol: `.claude/loop/LOOP.md`. Queue: `.claude/loop/GOALS.md`.

Do this now:

1. **Read** `.claude/loop/GOALS.md`. If `$ARGUMENTS` is non-empty, append each as a
   new `- [ ] <goal>` to the Queue first (bounded + verifiable; reword vague asks).
   If the queue has no `[ ]` goal, tell the user it's empty and stop — don't arm.
2. **Reset + arm:** set `.claude/loop/STATE.json` `iter` to 0, then
   `touch .claude/loop/ACTIVE`. (The Stop hook now enforces "keep going" until the
   queue is empty / a goal is `[!]` / `.claude/loop/PAUSE` exists / the cap is hit.)
3. **Work the first `[ ]` goal** through the per-goal pipeline in `LOOP.md`:
   feature-recon (reuse > rebuild) → plan → build → compile/typecheck → deploy →
   **e2e verify ON THE BOX (before any push)** → ship (commit author
   `amarsai3012005`, push; main = prod) → append `.claude/hyperagents/JOURNAL.md` →
   **mark the goal `[x]`** in GOALS.md (move it to Done with the commit sha).
4. **Advance** to the next `[ ]` automatically (the Stop hook re-injects it). One
   bounded decision per iteration; small complete verified increments only.
5. **Stop conditions:** mark a goal `[x]` only after it ships + verifies. If a goal
   needs a decision ONLY the user can make, mark it `[!]` with the reason and stop —
   never guess. The loop auto-disarms when the queue is clear.

Controls: pause = `touch .claude/loop/PAUSE`; stop = `rm .claude/loop/ACTIVE`;
runaway guard = `STATE.json.max_iter` (default 60, resets on each `[x]`).
