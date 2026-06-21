#!/usr/bin/env python3
"""Integration test for the self-evolving wiring in hyper/engine.py — NO live Groq.

Monkeypatches Director._groq to canned replies and asserts:
  1. _consult INJECTS the employee's playbook ("YOUR PLAYBOOK") when evo is active.
  2. _run_evo_reflection distills lessons and sets _evo_updates (merged, deduped).
  3. evo OFF (default) is fully inert — no playbook block, no _evo_updates.
  4. _evo_recall / _evo_merge pure-function correctness (the proven spike logic).

Run:  PYTHONPATH=../../src python3 test_evo_integration.py   (or just `python3 test_evo_integration.py`)
"""
import asyncio
import json
import os
import sys
from pathlib import Path

# make the package importable from this script's location
SRC = Path(__file__).resolve().parents[2] / "src"
sys.path.insert(0, str(SRC))

from hivemind_employees.hyper import engine as E  # noqa: E402

CAPTURED_SYSTEMS = []


def make_director(evo_mode, playbooks):
    parts = [
        {"slug": "fin", "name": "Fin", "_lane": "Finance", "persona": "You are Fin, finance."},
        {"slug": "eng", "name": "Eng", "_lane": "Engineering", "persona": "You are Eng, engineering."},
    ]

    async def _noop_emit(ev):
        return None

    d = E.Director(
        user_message="Should we prepay the annual contract to save 20%?",
        user_id="u1", org_id="o1", project_id="p1",
        participants=parts, room_template="decision", room_goal="Decide on the prepay",
        enabled_connectors=[], emit=_noop_emit,
        evo_mode=evo_mode, evo_playbooks=playbooks,
    )

    async def fake_groq(messages, *, tools=None, model=None, temp=0.4,
                        force_text=False, bucket="director", schema=None):
        sysmsg = next((m["content"] for m in messages if m["role"] == "system"), "")
        CAPTURED_SYSTEMS.append((bucket, sysmsg))
        if bucket == "evo":
            # reviewer/coach: weak on risk + next-step → emits 2 general lessons
            return {"content": json.dumps({
                "grounded": 0.9, "specific": 0.4, "risk_aware": 0.3,
                "on_goal": 0.8, "concise": 0.6,
                "lessons": ["End with one concrete next step, owner, and deadline.",
                            "Surface the single biggest risk before recommending."],
            })}
        # debate persona reply
        return {"content": f"[{model}] my take: prepay only if runway allows."}

    d._groq = fake_groq  # type: ignore
    return d


async def scenario_on():
    CAPTURED_SYSTEMS.clear()
    d = make_director("on", {"fin": ["Always tie advice to the ~13-month runway."]})
    assert d.evo_active, "evo should be active with mode=on and env default enabled"
    await d._debate("Should we prepay the annual contract?", 1)
    # 1. playbook injected for fin (it has a lesson), in a debate-bucket system prompt
    fin_sys = [s for (b, s) in CAPTURED_SYSTEMS if b == "debate" and "Fin" in s]
    assert fin_sys, "Fin was never consulted"
    assert any("YOUR PLAYBOOK" in s and "13-month runway" in s for s in fin_sys), \
        "playbook NOT injected into Fin's consult prompt"
    # eng has NO playbook → no block
    eng_sys = [s for (b, s) in CAPTURED_SYSTEMS if b == "debate" and "Eng" in s]
    assert eng_sys and not any("YOUR PLAYBOOK" in s for s in eng_sys), \
        "eng should have no playbook block"
    # 2. reflection produces merged updates
    await d._run_evo_reflection("Final: prepay; next step: CFO reviews cash by Friday; risk: vendor lock-in.")
    assert d._evo_updates is not None, "reflection produced no updates"
    assert "fin" in d._evo_updates and "eng" in d._evo_updates, "both employees should have learned"
    fin_pb = d._evo_updates["fin"]
    assert any("runway" in l for l in fin_pb), "fin's prior lesson must be carried forward"
    assert any("next step" in l.lower() for l in fin_pb), "fin should have learned the next-step lesson"
    assert len(fin_pb) <= E._EVO_CAP, "playbook must be bounded"
    print(f"  ✅ evo ON: playbook injected; learned fin={len(fin_pb)} eng={len(d._evo_updates['eng'])} lessons")


async def scenario_off():
    CAPTURED_SYSTEMS.clear()
    d = make_director("off", {"fin": ["Some prior lesson."]})
    assert not d.evo_active, "evo must be inactive when mode=off"
    await d._debate("topic", 1)
    assert not any("YOUR PLAYBOOK" in s for (_, s) in CAPTURED_SYSTEMS), \
        "OFF must inject NO playbook"
    await d._run_evo_reflection("final")
    assert d._evo_updates is None, "OFF must produce no updates"
    assert not any(b == "evo" for (b, _) in CAPTURED_SYSTEMS), "OFF must make no reflection calls"
    print("  ✅ evo OFF: fully inert (no injection, no reflection, no updates)")


def scenario_pure():
    # _evo_recall: relevant lessons surface; recency floor keeps newest
    pb = ["alpha runway lesson", "beta hiring lesson", "gamma vendor lesson", "delta newest lesson"]
    got = E._evo_recall(pb, "vendor contract prepay", k=2)
    assert "gamma vendor lesson" in got, "lexical match should surface the vendor lesson"
    assert "delta newest lesson" in got, "recency floor should keep the newest lesson"
    # _evo_merge: dedup near-duplicates, bound to cap
    base = ["End with one concrete next step and owner."]
    merged = E._evo_merge(base, ["End with a concrete next step and an owner."])  # near-dup
    assert len(merged) == 1, f"near-duplicate should be deduped, got {merged}"
    merged2 = E._evo_merge(base, ["Surface the biggest risk first."])  # distinct
    assert len(merged2) == 2, "distinct lesson should be added"
    capped = E._evo_merge([f"lesson number {i} distinct topic {i}" for i in range(40)], [], cap=12)
    assert len(capped) == 12, "must bound to cap"
    print("  ✅ pure: _evo_recall (relevance + recency) and _evo_merge (dedup + cap) correct")


async def main():
    print("self-evolve engine integration test (mocked Groq):")
    scenario_pure()
    await scenario_on()
    await scenario_off()
    print("ALL PASS ✅")


if __name__ == "__main__":
    asyncio.run(main())
