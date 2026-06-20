#!/usr/bin/env python3
"""Format the captured events (/tmp/room_runs.jsonl) + run metadata
(/tmp/sim_meta.json) into a clear, human-readable /tmp/log.txt: per run —
planner decision, each agent's contribution, recon-on-tasks, debate rounds,
final conclusion, recon verdict, artifacts."""
import json

events = []
for ln in open("/tmp/room_runs.jsonl"):
    ln = ln.strip()
    if ln:
        try:
            events.append(json.loads(ln))
        except Exception:
            pass
meta = json.load(open("/tmp/sim_meta.json"))

by_turn = {}
for e in events:
    by_turn.setdefault(e.get("turn_id"), []).append(e.get("event") or {})

L = []
L.append("=" * 78)
L.append("HYPERAGENTS — SOLVIS ROOM — REAL-WORLD SIMULATION LOG")
L.append("flow: PLAN -> all agents gather (parallel) -> recon-on-tasks -> debate -> conclude")
L.append("=" * 78)

for m in meta:
    evs = by_turn.get(m["turn_id"], [])
    L.append("")
    L.append("#" * 78)
    L.append(f"RUN: {m['role']}   ({m['ms']} ms · seal={m['resp'].get('status')} · {m['resp'].get('cost_tokens')} tok)")
    L.append(f"QUESTION: {m['q']}")
    L.append("#" * 78)

    plan = [e for e in evs if e.get("t") == "plan"]
    if plan:
        p = plan[-1]
        L.append(f"\n[1] PLANNER DECISION")
        L.append(f"    intended_output : {p.get('intended_output')}")
        L.append(f"    done_criterion  : {p.get('done_criterion')}")
        steps = p.get("steps") or []
        if steps:
            L.append("    subtasks:")
            for s in steps:
                L.append(f"      - {s}")
        else:
            L.append("    subtasks: (planner emitted none → fallback assigned EVERY agent its own gather subtask)")

    g = [e for e in evs if e.get("t") == "gather"]
    if g:
        L.append(f"\n[2] GATHER (room recall floor): memory_hits={g[-1].get('memory_hits')}")

    ex = [e for e in evs if e.get("t") == "execute" and not e.get("reconned")]
    L.append(f"\n[3] AGENTS — {len(ex)} executed IN PARALLEL (each its own subtask):")
    for e in ex:
        L.append(f"    • {e.get('name')}")
        L.append(f"        subtask: {e.get('subtask')}")
        L.append(f"        gathered: {(e.get('contribution') or '').strip()[:700]}")

    rc = [e for e in evs if e.get("t") == "recon"]
    redo = [e for e in evs if e.get("t") == "execute" and e.get("reconned")]
    if rc or redo:
        L.append(f"\n[4] RECON-ON-TASKS — {len(rc)} task(s) flagged with a gap, re-run:")
        for e in rc:
            L.append(f"    ! {e.get('owner')}: gap = {e.get('gap')}")
        for e in redo:
            L.append(f"    ↻ {e.get('name')} re-ran → {(e.get('contribution') or '').strip()[:400]}")

    rounds = [e for e in evs if e.get("t") == "round_start"]
    reacts = [e for e in evs if e.get("t") == "react"]
    if rounds or reacts:
        L.append(f"\n[5] DEBATE — {len(rounds)} round(s):")
        for e in reacts:
            L.append(f"    ⇄ R{e.get('round')} {e.get('agent')} [{e.get('agreement')} · conf {e.get('confidence')}]: {(e.get('line') or '').strip()[:300]}")
        sv = [e for e in evs if e.get("t") == "swarm_verdict"]
        if sv:
            L.append(f"    → verdict: converged={sv[-1].get('converged')} (round {sv[-1].get('round') or sv[-1].get('rounds')})")

    syn = [e for e in evs if e.get("t") == "line" and e.get("kind") == "synthesis"]
    fallback = [e for e in evs if e.get("t") == "line" and e.get("kind") in ("revise", "lead")]
    final = (syn[-1] if syn else (fallback[-1] if fallback else None))
    if final:
        L.append(f"\n[6] FINAL CONCLUSION:\n{final.get('content')}")
    de = [e for e in evs if e.get("t") == "line" and e.get("kind") == "dead_end"]
    if de:
        L.append(f"\n[!] HONEST DEAD-END:\n{de[-1].get('content')}")

    v = m["resp"].get("verification") or {}
    L.append(f"\n[7] RECON VERDICT: met={v.get('met')} grounded_ok={v.get('grounded_ok')} artifact_ok={v.get('artifact_ok')}")
    if v.get("gaps"):
        L.append(f"    gaps: {v.get('gaps')}")
    arts = m["resp"].get("artifacts") or []
    if arts:
        L.append("    artifacts: " + ", ".join(f"{a.get('connector')} → {a.get('url')}" for a in arts))
    pend = m["resp"].get("pending_approvals") or []
    if pend:
        L.append("    pending approvals: " + ", ".join(p.get("label", "") for p in pend))

open("/tmp/log.txt", "w").write("\n".join(L) + "\n")
print("wrote /tmp/log.txt", flush=True)
