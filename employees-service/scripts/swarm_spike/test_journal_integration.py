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
    cap = {"plan": [], "synth": [], "debate": []}

    async def fake_groq(messages, *, tools=None, model=None, temp=0.4, force_text=False,
                        bucket="director", schema=None):
        usr = next((m["content"] for m in messages if m["role"] == "user"), "")
        if bucket == "director" and schema is not None:
            cap["plan"].append(usr)
            return {"content": '{"recall_queries":[],"connector_calls":[],"web_query":null,"needs_debate":true,"intent":"deliberate"}'}
        if bucket == "synth":
            cap["synth"].append(usr)
            return {"content": "Final answer."}
        if bucket == "debate":
            cap["debate"].append(usr)
            return {"content": "my stance."}
        return {"content": "x"}

    d._groq = fake_groq  # type: ignore
    return d, cap


async def scenario_with_journal():
    journal = ["asked: double ads | decided: no — keep ads €30k (7%), preserve runway",
               "asked: budget split | decided: €240k salaries, €120k product, €30k ads"]
    d, cap = make_director(journal)
    await d._plan_gather()
    await d._synthesize(False, "")
    await d._debate("topic", 1)  # debate agents must ALSO see the journal
    assert cap["plan"] and "ROOM JOURNAL" in cap["plan"][0], "journal NOT injected into plan"
    assert "€30k" in cap["plan"][0], "journal figures missing from plan"
    assert cap["synth"] and "ROOM JOURNAL" in cap["synth"][0], "journal NOT injected into synth"
    assert "€30k" in cap["synth"][0], "journal figures missing from synth"
    assert cap["debate"] and all("ROOM JOURNAL" in c for c in cap["debate"]), "journal NOT injected into debate agents"
    print("  ✅ with journal: ROOM JOURNAL (+figures) injected into plan, synth, AND debate agents")


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
    cap = {"usr": ""}

    async def fake_evo_groq(messages, *, model, schema, temp=0.3):
        assert schema is None, "journal entry must use plain text (schema=None)"
        cap["usr"] = next((m["content"] for m in messages if m["role"] == "user"), "")
        return "asked: prepay vendor? | decided: yes — prepay 12mo saves 20% (€8k) | positions: Fin: yes; Vic: liquidity risk"
    E._evo_groq = fake_evo_groq  # type: ignore
    # no transcript → no positions block in the prompt
    line0 = await E.make_journal_entry("Should we prepay the vendor?", "Decision: prepay, saves 20%...")
    assert "WHAT EACH AGENT ARGUED" not in cap["usr"], "no transcript must omit the positions block"
    # WITH transcript → per-agent positions fed to the summariser
    tr = [{"round": 1, "agent": "Fin", "text": "Prepay — saves 20%, runway fine."},
          {"round": 2, "agent": "Fin", "text": "Still yes; lock the 20%."},
          {"round": 1, "agent": "Vic", "text": "Liquidity risk if cash tightens."}]
    line = await E.make_journal_entry("Should we prepay the vendor?", "Decision: prepay, saves 20%...", transcript=tr)
    assert "WHAT EACH AGENT ARGUED" in cap["usr"] and "Fin:" in cap["usr"] and "Vic:" in cap["usr"], \
        "transcript must feed per-agent positions to the summariser"
    assert "Still yes" in cap["usr"], "should keep each agent's LATEST stance"
    assert line and "positions:" in line, f"entry missing positions slice: {line}"
    print(f"  ✅ per-agent slice: positions fed when debate happened; '{line[:72]}…'")


async def main():
    print("swarm-journal engine integration test (mocked Groq):")
    scenario_cap()
    await scenario_with_journal()
    await scenario_empty()
    await scenario_entry()
    print("ALL PASS ✅")


if __name__ == "__main__":
    asyncio.run(main())
