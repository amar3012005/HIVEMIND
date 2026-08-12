"""An explicit @mention already routes deterministically to one employee,
skipping debate+verification for a fast, in-character direct answer.
Confirmed live 2026-08-12 that this works well ("@ravi-patel-6 what are our
next steps" got a fast, correct, contextual reply). The follow-up ask: the
SAME routing, even without typing the tag, when a message is clearly meant
for one specific person. _classify_implicit_direct_route is a single cheap
classifier call deciding that — conservative by design, since a wrong "yes"
silently drops debate+governance for a question that needed the full team.
"""
import asyncio
import json

import hivemind_employees.api_hyper_rooms as api


def _req(message="what are our next steps"):
    return api.RoomTurnRequest(
        room_id="room-1", turn_id="turn-1", user_id="user-1", org_id="org-1",
        user_message=message, participant_ids=[], callback_url="http://x/unused",
    )


def _participants():
    return [
        {"slug": "ravi-patel-6", "name": "Ravi Patel", "_lane": "Communicator"},
        {"slug": "lina-meyer", "name": "Lina Meyer", "_lane": "Skeptic"},
        {"slug": "elena-kovacs", "name": "Elena Kovács", "_lane": "Strategist"},
    ]


def _fake_openrouter_response(direct_to_agent, agent_slug, reason="test"):
    return {"choices": [{"message": {"content": json.dumps(
        {"direct_to_agent": direct_to_agent, "agent_slug": agent_slug, "reason": reason}
    )}}]}


def test_returns_none_with_fewer_than_two_participants():
    result = asyncio.run(api._classify_implicit_direct_route(
        _req(), [{"slug": "solo", "name": "Solo", "_lane": "Communicator"}],
    ))
    assert result is None


def test_routes_direct_when_classifier_says_yes_with_a_real_slug(monkeypatch):
    async def fake_chat(body, *, timeout):
        return _fake_openrouter_response(True, "lina-meyer")
    monkeypatch.setattr(api, "_openrouter_chat", fake_chat)

    result = asyncio.run(api._classify_implicit_direct_route(_req("what's Lina's take on this?"), _participants()))

    assert result is not None
    assert result["slug"] == "lina-meyer"


def test_does_not_route_when_classifier_says_no(monkeypatch):
    async def fake_chat(body, *, timeout):
        return _fake_openrouter_response(False, None)
    monkeypatch.setattr(api, "_openrouter_chat", fake_chat)

    result = asyncio.run(api._classify_implicit_direct_route(_req("what should we do as a team?"), _participants()))

    assert result is None


def test_does_not_route_when_classifier_names_an_unknown_slug(monkeypatch):
    # Safety net: never trust the classifier's slug blindly, only route to a
    # participant that actually exists in THIS room's roster.
    async def fake_chat(body, *, timeout):
        return _fake_openrouter_response(True, "someone-not-in-the-room")
    monkeypatch.setattr(api, "_openrouter_chat", fake_chat)

    result = asyncio.run(api._classify_implicit_direct_route(_req(), _participants()))

    assert result is None


def test_fails_open_to_no_route_on_classifier_exception(monkeypatch):
    async def broken_chat(body, *, timeout):
        raise RuntimeError("provider outage")
    monkeypatch.setattr(api, "_openrouter_chat", broken_chat)

    result = asyncio.run(api._classify_implicit_direct_route(_req(), _participants()))

    assert result is None, "a classifier failure must default to the full pipeline, never crash the turn"


def test_fails_open_to_no_route_on_unparseable_response(monkeypatch):
    async def fake_chat(body, *, timeout):
        return {"choices": [{"message": {"content": "not json at all"}}]}
    monkeypatch.setattr(api, "_openrouter_chat", fake_chat)

    result = asyncio.run(api._classify_implicit_direct_route(_req(), _participants()))

    assert result is None


def test_falls_back_to_the_default_model_when_the_primary_is_unavailable(monkeypatch):
    calls = []

    async def fake_chat(body, *, timeout):
        calls.append(dict(body))
        if body["model"] == "nvidia/nemotron-3.5-lightning":
            return None
        return _fake_openrouter_response(True, "lina-meyer")
    monkeypatch.setattr(api, "_openrouter_chat", fake_chat)
    monkeypatch.setenv("HYPER_DIRECT_ROUTE_MODEL", "nvidia/nemotron-3.5-lightning")

    result = asyncio.run(api._classify_implicit_direct_route(_req(), _participants()))

    assert result is not None
    assert result["slug"] == "lina-meyer"
    assert len(calls) == 2
    assert calls[1]["model"] == "openai/gpt-oss-120b"
