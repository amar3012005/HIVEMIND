"""make_journal_entry used a bare truthy check on the LLM's swarm_summary
output, so a degenerate response ("...") passed straight through untouched.
Confirmed live 2026-08-12: the summarizer returned literally swarm_summary="..."
for a "what did we learn" turn, permanently writing a content-free entry that
then polluted the room's own journal for every later turn — the room
answered "what did you learn" by re-deriving generic company facts instead
of citing its own real prior decision, because the compact journal row for
that entry carried no actual content to cite.
"""
import asyncio
import json

from hivemind_employees.hyper import engine
from hivemind_employees.hyper.engine import make_journal_entry


def test_degenerate_swarm_summary_falls_back_to_final_text(monkeypatch):
    async def fake_evo_groq(messages, *, model, schema):
        return json.dumps({"asked": "what did we learn", "swarm_summary": "...", "agents": []})
    monkeypatch.setattr(engine, "_evo_groq", fake_evo_groq)

    entry = asyncio.run(make_journal_entry(
        "what did we learn from this",
        "The swarm confirmed 12% CAGR and >65% enterprise interest in GDPR-native AI tools.",
        transcript=[], participants=[], turn_id="t1",
    ))

    assert entry is not None
    assert entry["swarm_summary"] != "..."
    assert "12% CAGR" in entry["swarm_summary"], "must fall back to real final_text, not the placeholder"


def test_short_placeholder_like_summaries_are_also_rejected(monkeypatch):
    for placeholder in ("...", "N/A", "None", "-", "ok"):
        async def fake_evo_groq(messages, *, model, schema, _p=placeholder):
            return json.dumps({"asked": "x", "swarm_summary": _p, "agents": []})
        monkeypatch.setattr(engine, "_evo_groq", fake_evo_groq)

        entry = asyncio.run(make_journal_entry(
            "some question", "A real, substantive final answer with actual content in it.",
            transcript=[], participants=[], turn_id="t1",
        ))
        assert entry["swarm_summary"] != placeholder, f"placeholder {placeholder!r} must be rejected"


def test_a_real_substantive_summary_passes_through_unchanged(monkeypatch):
    real_summary = "Confirmed GDPR-native AI demand: 12% CAGR, >65% enterprise interest, competitor gaps flagged."

    async def fake_evo_groq(messages, *, model, schema):
        return json.dumps({"asked": "Validate demand", "swarm_summary": real_summary, "agents": []})
    monkeypatch.setattr(engine, "_evo_groq", fake_evo_groq)

    entry = asyncio.run(make_journal_entry(
        "validate demand", "some final text", transcript=[], participants=[], turn_id="t1",
    ))

    assert entry["swarm_summary"] == real_summary, "a real summary must never be overridden by the fallback"


def test_evo_groq_failure_falls_back_cleanly(monkeypatch):
    async def broken_evo_groq(messages, *, model, schema):
        raise RuntimeError("provider outage")
    monkeypatch.setattr(engine, "_evo_groq", broken_evo_groq)

    entry = asyncio.run(make_journal_entry(
        "what happened", "A real final answer with enough content to survive the fallback path.",
        transcript=[], participants=[], turn_id="t1",
    ))

    assert entry is not None
    assert "real final answer" in entry["swarm_summary"]


def test_fast_planner_journal_is_deterministic_without_model_call(monkeypatch):
    async def forbidden(*_args, **_kwargs):
        raise AssertionError("journal model must not run")
    monkeypatch.setattr(engine, "_evo_groq", forbidden)
    entry = asyncio.run(make_journal_entry(
        "refine the tagline", "A concise evidence-backed positioning recommendation.",
        transcript=[], participants=[], turn_id="t-fast", fast_planner_mode="glm_no_reasoning",
    ))
    assert entry["turn_id"] == "t-fast"
    assert "evidence-backed" in entry["swarm_summary"]
