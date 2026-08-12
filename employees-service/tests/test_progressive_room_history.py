"""Every turn used to look like a fresh conversation — the eager room-journal
window only covers the last 8 turns, and until this fix the underlying
storage was destructively trimmed to that same 8, so there was no older
history to reach for even on demand. Confirmed live 2026-08-12: a room asked
"what did you learn from this" and the Director re-ran a full gather+debate
instead of answering from its own prior "Validate European AI Compliance
Demand" decision, because the prompt framed the journal as a soft
consistency hint, never something to answer FROM directly.

This adds the progressive-load path: the planner can request more history
via `history_turns_back`, `_run_gather` pulls it into the blackboard on
demand — same pattern as method_skills, just for room history instead of
skill bodies.
"""
import asyncio
import json

from hivemind_employees.hyper.engine import Director


def _director(**overrides):
    events = []

    async def emit(event):
        events.append(event)

    kwargs = dict(
        user_message="what did we learn from this", user_id="user-1", org_id="org-1",
        project_id=None, participants=[{"slug": "lead", "name": "Lead", "_lane": "Strategist"}],
        room_template="auto", room_goal="", enabled_connectors=[], emit=emit,
        room_kind="general", room_id="room-1",
    )
    kwargs.update(overrides)
    return Director(**kwargs), events


_MINIMAL_PLAN = {
    "recall_queries": [], "connector_calls": [], "web_query": None,
    "seo_audit_url": None, "places_query": None, "method_skills": [],
    "campaign_method_assignments": [], "history_turns_back": 0,
}


def test_zero_history_turns_back_loads_nothing(monkeypatch):
    director, events = _director()
    called = {"n": 0}

    async def fake_load(self, turns_back):
        called["n"] += 1
        return json.dumps({"turns_returned": 0, "history": []})
    monkeypatch.setattr(Director, "_load_room_history", fake_load)

    asyncio.run(director._run_gather(dict(_MINIMAL_PLAN)))

    assert called["n"] == 0, "history_turns_back=0 must never call the history loader"


def test_nonzero_history_turns_back_loads_history_onto_the_blackboard(monkeypatch):
    director, events = _director()

    async def fake_load(self, turns_back):
        assert turns_back == 15
        return json.dumps({"turns_returned": 2, "history": [
            {"asked": "Validate European AI Compliance Demand",
             "swarm_summary": "Confirmed 12% CAGR, >65% enterprise interest.",
             "agents": [{"name": "Elena Kovács", "contribution": "market size"}]},
            {"asked": "Check competitor landscape", "swarm_summary": "No direct competitors found.", "agents": []},
        ]})
    monkeypatch.setattr(Director, "_load_room_history", fake_load)

    plan = dict(_MINIMAL_PLAN)
    plan["history_turns_back"] = 15
    asyncio.run(director._run_gather(plan))

    joined = "\n".join(director.blackboard)
    assert "Validate European AI Compliance Demand" in joined
    assert "12% CAGR" in joined
    assert "Elena Kovács: market size" in joined
    assert "No direct competitors found" in joined

    gather_events = [e for e in events if e.get("t") == "gather" and e.get("sources") == ["room_history"]]
    assert len(gather_events) == 1
    assert gather_events[0]["memory_hits"] == 2


def test_load_room_history_returns_error_json_without_a_room_id():
    director, _events = _director(room_id="")
    result = asyncio.run(director._load_room_history(20))
    parsed = json.loads(result)
    assert "error" in parsed


def test_load_room_history_calls_get_room_journal_with_the_requested_depth(monkeypatch):
    director, _events = _director(room_id="room-42", org_id="org-42")

    captured = {}

    async def fake_get_room_journal(room_id, org_id, limit=8):
        captured["args"] = (room_id, org_id, limit)
        return [{"asked": "x", "swarm_summary": "y", "agents": []}]

    monkeypatch.setattr("hivemind_employees.hyper.engine.get_room_journal", fake_get_room_journal)

    result = asyncio.run(director._load_room_history(30))
    parsed = json.loads(result)

    assert captured["args"] == ("room-42", "org-42", 30)
    assert parsed["turns_returned"] == 1


def test_load_room_history_bounds_turns_back_to_a_sane_range(monkeypatch):
    director, _events = _director(room_id="room-1", org_id="org-1")
    captured = {}

    async def fake_get_room_journal(room_id, org_id, limit=8):
        captured["limit"] = limit
        return []

    monkeypatch.setattr("hivemind_employees.hyper.engine.get_room_journal", fake_get_room_journal)

    asyncio.run(director._load_room_history(99999))
    assert captured["limit"] == 200, "must clamp to the storage cap, not pass an unbounded request through"

    asyncio.run(director._load_room_history(0))
    assert captured["limit"] == 20, "0/falsy turns_back falls back to the sensible default (20), not a no-op"
