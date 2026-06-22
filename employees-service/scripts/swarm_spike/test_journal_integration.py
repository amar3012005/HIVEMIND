#!/usr/bin/env python3
"""Integration test for the swarm-journal wiring in hyper/engine.py — NO live Groq.

Asserts:
  1. With a journal, the ROOM JOURNAL block is injected into BOTH the plan and the synth prompts.
  2. Empty journal → NO journal block anywhere (first turn / disabled → zero added cost).
  3. _journal_block respects the keep-cap (only the last N entries).
  4. make_journal_entry() compacts a turn (mocked groq) into one line.

Run:  PYTHONPATH=../../src python3 test_journal_integration.py
"""
import asyncio
import sys
from pathlib import Path

SRC = Path(__file__).resolve().parents[2] / "src"
sys.path.insert(0, str(SRC))
from hivemind_employees.hyper import engine as E  # noqa: E402

PARTS = [{"slug": "fin", "name": "Fin", "_lane": "Finance", "persona": "finance"},
         {"slug": "vic", "name": "Vic", "_lane": "Skeptic", "persona": "skeptic"}]


def make_director(journal):
    async def emit(ev):
        return None
    d = E.Director(
        user_message="What did we allocate to ads?", user_id="u", org_id="o", project_id=None,
        participants=PARTS, room_template="decision", room_goal="GTM + spend",
        enabled_connectors=[], emit=emit, journal=journal)
    cap = {"plan": [], "synth": []}

    async def fake_groq(messages, *, tools=None, model=None, temp=0.4, force_text=False,
                        bucket="director", schema=None):
        usr = next((m["content"] for m in messages if m["role"] == "user"), "")
        if bucket == "director" and schema is not None:
            cap["plan"].append(usr)
            return {"content": '{"recall_queries":[],"connector_calls":[],"web_query":null,"needs_debate":false}'}
        if bucket == "synth":
            cap["synth"].append(usr)
            return {"content": "Final answer."}
        return {"content": "x"}

    d._groq = fake_groq  # type: ignore
    return d, cap


async def scenario_with_journal():
    journal = ["asked: double ads | decided: no — keep ads €30k (7%), preserve runway",
               "asked: budget split | decided: €240k salaries, €120k product, €30k ads"]
    d, cap = make_director(journal)
    await d._plan_gather()
    await d._synthesize(False, "")
    assert cap["plan"] and "ROOM JOURNAL" in cap["plan"][0], "journal NOT injected into plan"
    assert "€30k" in cap["plan"][0], "journal figures missing from plan"
    assert cap["synth"] and "ROOM JOURNAL" in cap["synth"][0], "journal NOT injected into synth"
    assert "€30k" in cap["synth"][0], "journal figures missing from synth"
    print("  ✅ with journal: ROOM JOURNAL (+figures) injected into BOTH plan and synth")


async def scenario_empty():
    d, cap = make_director([])
    await d._plan_gather()
    await d._synthesize(False, "")
    assert "ROOM JOURNAL" not in cap["plan"][0] and "ROOM JOURNAL" not in cap["synth"][0], \
        "empty journal must inject NOTHING"
    print("  ✅ empty journal: no block injected (first turn = zero added cost)")


def scenario_cap():
    big = [f"entry {i}" for i in range(20)]
    d, _ = make_director(big)
    block = d._journal_block()
    assert block.count("- entry") == E._JOURNAL_KEEP, f"must keep only last {E._JOURNAL_KEEP}"
    assert f"entry {19}" in block and "entry 0" not in block, "must keep the NEWEST entries"
    print(f"  ✅ cap: journal bounded to last {E._JOURNAL_KEEP} (newest kept)")


async def scenario_entry():
    async def fake_evo_groq(messages, *, model, schema, temp=0.3):
        assert schema is None, "journal entry must use plain text (schema=None)"
        return "asked: prepay vendor? | decided: yes — prepay 12mo saves 20% (€8k); CFO confirms Fri"
    E._evo_groq = fake_evo_groq  # type: ignore
    line = await E.make_journal_entry("Should we prepay the vendor?", "Decision: prepay, saves 20%...")
    assert line and "decided:" in line and "20%" in line, f"bad entry: {line}"
    print(f"  ✅ make_journal_entry: '{line[:60]}…'")


async def main():
    print("swarm-journal engine integration test (mocked Groq):")
    scenario_cap()
    await scenario_with_journal()
    await scenario_empty()
    await scenario_entry()
    print("ALL PASS ✅")


if __name__ == "__main__":
    asyncio.run(main())
