#!/usr/bin/env python3
"""Integration test for the board-digest wiring in hyper/engine.py — NO live Groq.

Asserts:
  1. FAT board  → ONE digest call (bucket=digest); debate consults get the DIGEST, not the raw noise.
  2. SMALL board → NO digest call; consults get the raw board (digest would be net overhead).
  3. Synth ALWAYS gets the RAW board (never the digest) — the deliverable's grounding source.
  4. Digest empty (model returns nothing) → fail-open: consults fall back to raw.

Run:  PYTHONPATH=../../src python3 test_digest_integration.py  (or just `python3 test_digest_integration.py`)
"""
import asyncio
import sys
from pathlib import Path

SRC = Path(__file__).resolve().parents[2] / "src"
sys.path.insert(0, str(SRC))
from hivemind_employees.hyper import engine as E  # noqa: E402

NOISE = "irrelevant office lease laptop offsite blog datapoint cohort churn expansion sample"
DIGEST_MARK = "DENSE-DIGEST-MARKER cash 1.9M burn 140k"
PARTS = [
    {"slug": "fin", "name": "Fin", "_lane": "Finance", "persona": "finance"},
    {"slug": "vic", "name": "Vic", "_lane": "Skeptic", "persona": "skeptic"},
]


def make_director(board_items, digest_returns=DIGEST_MARK):
    async def emit(ev):
        return None
    d = E.Director(
        user_message="Double ads or extend runway?", user_id="u", org_id="o", project_id=None,
        participants=PARTS, room_template="decision", room_goal="GTM + spend before the raise",
        enabled_connectors=[], emit=emit)
    d.blackboard = list(board_items)
    calls = {"digest": 0, "debate_ctx": [], "synth_ctx": []}

    async def fake_groq(messages, *, tools=None, model=None, temp=0.4, force_text=False,
                        bucket="director", schema=None):
        usr = next((m["content"] for m in messages if m["role"] == "user"), "")
        if bucket == "digest":
            calls["digest"] += 1
            return {"content": digest_returns}
        if bucket == "debate":
            calls["debate_ctx"].append(usr)
            return {"content": "my take: depends on runway."}
        if bucket == "synth":
            calls["synth_ctx"].append(usr)
            return {"content": "Final: hold spend."}
        return {"content": "x"}

    d._groq = fake_groq  # type: ignore
    return d, calls


async def scenario_fat():
    big = [f"- KB[item-{i}]: {NOISE} detail {i} with figure {100+i}k (source: mem:{i})." for i in range(40)]
    big[0] = "- KB[finance]: cash 1.9M, burn 140k/mo, 13mo runway (source: mem:fin)."
    assert len("\n".join(big)) >= E._DIGEST_MIN_CHARS, "board must exceed the gate to test digest"
    d, calls = make_director(big)
    await d._debate("Double ads or extend runway?", 2)
    assert calls["digest"] == 1, f"fat board must trigger exactly ONE digest call, got {calls['digest']}"
    assert calls["debate_ctx"], "no debate consults ran"
    assert all(DIGEST_MARK in c for c in calls["debate_ctx"]), "debate consults did NOT get the digest"
    assert all(NOISE not in c for c in calls["debate_ctx"]), "debate consult got raw noise (should be digest only)"
    # synth must still get the RAW board
    await d._synthesize(True, "{}")
    assert calls["synth_ctx"] and NOISE in calls["synth_ctx"][0] and DIGEST_MARK not in calls["synth_ctx"][0], \
        "synth must use the RAW board, never the digest"
    print(f"  ✅ FAT board: 1 digest call; {len(calls['debate_ctx'])} consults got the digest; synth got raw")


async def scenario_small():
    small = ["- KB[finance]: cash 1.9M, burn 140k/mo (source: mem:fin)."]
    assert len("\n".join(small)) < E._DIGEST_MIN_CHARS
    d, calls = make_director(small)
    await d._debate("topic", 1)
    assert calls["digest"] == 0, "small board must NOT call the digester (overhead)"
    assert calls["debate_ctx"] and all("1.9M" in c for c in calls["debate_ctx"]), "consults must get raw board"
    print("  ✅ SMALL board: no digest call; consults got the raw board")


async def scenario_failopen():
    big = [f"- KB[item-{i}]: {NOISE} detail {i} figure {i}k (source: mem:{i})." for i in range(40)]
    d, calls = make_director(big, digest_returns="")  # digester returns empty → fail-open
    await d._debate("topic", 1)
    assert calls["digest"] == 1, "digest attempted"
    assert calls["debate_ctx"] and all(NOISE in c for c in calls["debate_ctx"]), \
        "empty digest must fail-open to the RAW board"
    print("  ✅ fail-open: empty digest → debate falls back to raw")


async def main():
    print("board-digest engine integration test (mocked Groq):")
    await scenario_fat()
    await scenario_small()
    await scenario_failopen()
    print("ALL PASS ✅")


if __name__ == "__main__":
    asyncio.run(main())
