# Autonomous Goal Queue

The loop works these **top-to-bottom, one at a time**. While any `[ ]`/`[~]` goal
remains, the Stop hook (`.claude/hooks/goal-loop-stop.py`) blocks the session from
ending and re-injects the current goal — so "keep going" is the default.

Status: `[ ]` pending · `[~]` in progress · `[x]` shipped+verified · `[!]` blocked (needs human → pauses the loop)

**How to use:** add goals as `- [ ] <one concrete, bounded, verifiable goal>`, then
say "run the loop" (or `/loop`). To pause: create `.claude/loop/PAUSE` (or mark the
active goal `[!]`). To stop a goal cleanly: the agent marks it `[x]` after it ships
+ verifies on the box.

**Write good goals:** bounded + verifiable + independent. "Add X endpoint + e2e test"
✓. "Make it better" ✗ (the agent will mark that `[!]` and ask).

---

## Queue

<!-- add goals below; the loop takes the first [ ] -->
<!-- example goal (not live; copy the format): "- [ ] Add /health/deep to core checking Qdrant+Postgres+Redis, e2e-verify on box before shipping" -->

## Done (archive — newest first)
<!-- the agent moves [x] goals here with their commit sha -->

