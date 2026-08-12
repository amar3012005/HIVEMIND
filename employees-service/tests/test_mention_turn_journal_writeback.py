"""_run_mention_turn (the @agent direct-answer fast path) never called
make_journal_entry/append_room_journal_entry at all — confirmed live
2026-08-12: Ravi answered "@ravi-patel-6 what are our next steps" with a real
MOU action plan, and that decision was invisible to every later turn's
journal continuity, because the mention path writes nothing back. It also
never read the room's own journal into its own prompt, only the last-4-turn
recent-discussion window. Both are now wired the same way the full Director
turn already does it.
"""
import asyncio

import hivemind_employees.api_hyper_rooms as api


def _req(**overrides):
    kwargs = dict(
        room_id="room-1", turn_id="turn-1", user_id="user-1", org_id="org-1",
        user_message="@ravi-patel-6 what are our next steps",
        participant_ids=[], callback_url="http://x/unused",
    )
    kwargs.update(overrides)
    return api.RoomTurnRequest(**kwargs)


def _emp():
    return {"slug": "ravi-patel-6", "name": "Ravi Patel", "_lane": "Communicator", "persona": "Ravi."}


def _patch_common(monkeypatch, *, journal_entries=None, mention_content="Next steps: draft the MOU."):
    events = []

    async def fake_emit_event(callback_url, turn_id, event):
        events.append(event)
    monkeypatch.setattr(api, "_emit_event", fake_emit_event)

    async def fake_build_company_brief(*args, **kwargs):
        return "Company: Singulance Labs"
    monkeypatch.setattr(api, "_build_company_brief", fake_build_company_brief)

    async def fake_recall_emulated(*args, **kwargs):
        return {"memories": []}
    monkeypatch.setattr(api, "recall_emulated", fake_recall_emulated)

    async def fake_get_employee_playbooks_map(*args, **kwargs):
        return {}
    monkeypatch.setattr(api, "get_employee_playbooks_map", fake_get_employee_playbooks_map)

    async def fake_get_recent_turn_context(*args, **kwargs):
        return []
    monkeypatch.setattr(api, "get_recent_turn_context", fake_get_recent_turn_context)

    async def fake_get_room_journal(room_id, org_id, limit=8):
        return journal_entries or []
    monkeypatch.setattr(api, "get_room_journal", fake_get_room_journal)

    captured_prompt = {}

    async def fake_run_mention_reply(messages, **kwargs):
        captured_prompt["messages"] = messages
        return mention_content, {"total": 42, "in": 20, "out": 22, "cached": 0}
    monkeypatch.setattr(api, "run_mention_reply", fake_run_mention_reply)

    return events, captured_prompt


def test_mention_reply_writes_back_to_room_journal(monkeypatch):
    events, _ = _patch_common(monkeypatch)

    journal_calls = {}

    async def fake_make_journal_entry(user_message, final_text, **kwargs):
        journal_calls["user_message"] = user_message
        journal_calls["final_text"] = final_text
        journal_calls["turn_id"] = kwargs.get("turn_id")
        return {"turn_id": kwargs.get("turn_id"), "asked": user_message, "swarm_summary": final_text}
    monkeypatch.setattr(api, "make_journal_entry", fake_make_journal_entry)

    appended = {}

    async def fake_append(room_id, org_id, entry):
        appended["args"] = (room_id, org_id, entry)
        return True
    monkeypatch.setattr(api, "append_room_journal_entry", fake_append)

    result = asyncio.run(api._run_mention_turn(_req(), _emp(), 0.0))

    assert result.status == "complete"
    assert journal_calls["user_message"] == "@ravi-patel-6 what are our next steps"
    assert journal_calls["final_text"] == "Next steps: draft the MOU."
    assert journal_calls["turn_id"] == "turn-1"
    assert appended["args"][0] == "room-1"
    assert appended["args"][1] == "org-1"

    journal_events = [e for e in events if e.get("t") == "room_journal"]
    assert len(journal_events) == 1, "the FE must see the same room_journal event a full Director turn emits"


def test_mention_reply_reads_prior_journal_into_its_own_prompt(monkeypatch):
    prior = [{"asked": "Validate European AI Compliance Demand",
              "swarm_summary": "Confirmed 12% CAGR, >65% enterprise interest."}]
    _events, captured_prompt = _patch_common(monkeypatch, journal_entries=prior)

    async def fake_make_journal_entry(*args, **kwargs):
        return None
    monkeypatch.setattr(api, "make_journal_entry", fake_make_journal_entry)
    monkeypatch.setattr(api, "append_room_journal_entry", lambda *a, **k: asyncio.sleep(0, result=True))

    asyncio.run(api._run_mention_turn(_req(), _emp(), 0.0))

    user_content = captured_prompt["messages"][1]["content"]
    assert "Validate European AI Compliance Demand" in user_content
    assert "12% CAGR" in user_content


def test_mention_reply_journal_failure_never_breaks_the_turn(monkeypatch):
    events, _ = _patch_common(monkeypatch)

    async def broken_make_journal_entry(*args, **kwargs):
        raise RuntimeError("journal summarizer down")
    monkeypatch.setattr(api, "make_journal_entry", broken_make_journal_entry)

    result = asyncio.run(api._run_mention_turn(_req(), _emp(), 0.0))

    assert result.status == "complete", "a journal write failure must never fail the user-facing reply"
    seal_events = [e for e in events if e.get("t") == "seal"]
    assert len(seal_events) == 1
    assert seal_events[0]["status"] == "complete"
