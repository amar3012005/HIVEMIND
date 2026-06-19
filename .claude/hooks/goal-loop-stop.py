#!/usr/bin/env python3
"""Autonomous goal-loop Stop hook (repo-level).

Makes "keep going" the default: on Stop, if the goal queue (.claude/loop/GOALS.md)
has an unfinished goal, BLOCK the stop and re-inject the current goal + the loop
protocol so the agent advances to the next goal one-by-one.

Pause conditions (allow stop):
  - queue empty / all goals [x]            → loop complete
  - the first unfinished goal is [!]        → blocked, the human's turn
  - .claude/loop/PAUSE sentinel exists      → user paused the loop
  - iteration cap hit (STATE.json `iter`)   → runaway guard

Goal line format in GOALS.md:  "- [ ] <goal>"  ([ ] pending · [~] active ·
[x] done · [!] blocked-needs-human). The agent marks [x] when a goal ships and
[!] when it genuinely needs a human decision (that pauses the loop).
"""
import json
import os
import re
import sys

REPO = os.environ.get("CLAUDE_PROJECT_DIR") or "/Users/amar/HIVE-MIND"
LOOP_DIR = os.path.join(REPO, ".claude", "loop")
GOALS = os.path.join(LOOP_DIR, "GOALS.md")
STATE = os.path.join(LOOP_DIR, "STATE.json")
PAUSE = os.path.join(LOOP_DIR, "PAUSE")
ACTIVE = os.path.join(LOOP_DIR, "ACTIVE")  # arm sentinel — loop enforces ONLY when present
PROTOCOL = os.path.join(REPO, ".claude", "loop", "LOOP.md")


def _disarm():
    try:
        os.remove(ACTIVE)
    except Exception:
        pass


def _allow():
    sys.exit(0)  # exit 0, no output → stop proceeds normally


def _block(reason: str):
    print(json.dumps({"decision": "block", "reason": reason}))
    sys.exit(0)


def _load_state() -> dict:
    try:
        with open(STATE) as f:
            return json.load(f)
    except Exception:
        return {}


def _save_state(s: dict) -> None:
    try:
        os.makedirs(LOOP_DIR, exist_ok=True)
        with open(STATE, "w") as f:
            json.dump(s, f, indent=2)
    except Exception:
        pass


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        payload = {}
    # Don't re-fire if this very hook already forced a continue and the model
    # is mid-resume — avoids a tight pathological loop within one Stop event.
    if payload.get("stop_hook_active"):
        _allow()
    # Opt-in: the loop enforces ONLY when explicitly armed (.claude/loop/ACTIVE).
    # Without this, normal sessions would be trapped by any pending goal.
    if not os.path.exists(ACTIVE) or not os.path.exists(GOALS) or os.path.exists(PAUSE):
        _allow()

    try:
        lines = open(GOALS).read().splitlines()
    except Exception:
        _allow()

    goals = []  # (status_char, text)
    for ln in lines:
        m = re.match(r"\s*-\s*\[([ x~!])\]\s+(.*)", ln)
        if m:
            goals.append((m.group(1), m.group(2).strip()))

    unfinished = [(c, t) for c, t in goals if c in (" ", "~")]
    first_unfinished = next((g for g in goals if g[0] in (" ", "~", "!")), None)

    # All done / none → loop complete. Disarm so a later goal doesn't auto-resume.
    if not first_unfinished:
        _disarm()
        _allow()
    # First unfinished goal is BLOCKED ([!]) → pause for the human (allow stop).
    if first_unfinished[0] == "!":
        _allow()
    if not unfinished:
        _allow()

    # Iteration cap — runaway guard. Resets whenever a goal flips to [x]
    # (tracked by done-count delta).
    st = _load_state()
    done_now = sum(1 for c, _ in goals if c == "x")
    cap = int(st.get("max_iter", 60))
    it = int(st.get("iter", 0))
    if done_now != st.get("done_count"):
        it = 0  # progress made → reset the runaway counter
    it += 1
    st.update({"iter": it, "done_count": done_now, "current": unfinished[0][1]})
    _save_state(st)
    if it > cap:
        _disarm()
        _block(f"⏸ GOAL LOOP — iteration cap ({cap}) hit without a goal completing. "
               f"Likely stuck on: {unfinished[0][1]}. Disarmed to avoid a runaway. "
               f"Mark it [!] in .claude/loop/GOALS.md with why, or raise max_iter in STATE.json + re-arm.")
        return

    goal = unfinished[0][1]
    _block(
        f"AUTONOMOUS GOAL LOOP — keep going (iter {it}/{cap}). Current goal:\n"
        f"  ▸ {goal}\n\n"
        f"Follow {PROTOCOL}: feature-recon (reuse>rebuild) → plan → build → "
        f"compile/typecheck → deploy → e2e verify ON THE BOX → ship (commit+push) → "
        f"JOURNAL → mark this goal [x] in .claude/loop/GOALS.md. VERIFY BEFORE SHIP. "
        f"State lives in git + memory + GOALS.md (survives compaction). When this goal "
        f"is shipped+verified, mark [x] and start the next [ ]. If genuinely blocked on a "
        f"decision ONLY the user can make, mark this goal [!] with the reason and stop — "
        f"do NOT guess. Do not stop while a [ ]/[~] goal remains."
    )


if __name__ == "__main__":
    main()
