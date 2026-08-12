"""_run_direct_answer_agent is the module-level function actually invoking
the lead's real AgentScope agent for the direct-answer-hook path (see
test_direct_answer_agent_hook.py for the Director-side gating logic this
feeds). Tests here cover the invocation itself: prompt shape, text
extraction, and fail-open behavior on any error.
"""
import asyncio

import hivemind_employees.api_hyper_rooms as api


class _FakeReply:
    def __init__(self, content):
        self.content = content


def test_returns_the_agent_reply_text(monkeypatch):
    captured = {}

    async def fake_build_agent(room_id, lead, *, user_id, org_id, project_id):
        async def agent(msg):
            captured["prompt"] = msg.content
            return _FakeReply("A real, grounded answer from the agent.")
        return agent
    monkeypatch.setattr(api, "_build_agent_for_room", fake_build_agent)

    result = asyncio.run(api._run_direct_answer_agent(
        "room-1", {"slug": "lead"}, "user-1", "org-1", None, "turn-1",
        "what's our biggest risk?", "COMPANY FACTS: ...",
    ))

    assert result == "A real, grounded answer from the agent."
    assert "what's our biggest risk?" in captured["prompt"]
    assert "COMPANY FACTS" in captured["prompt"]


def test_returns_none_when_agent_build_fails(monkeypatch):
    async def broken_build_agent(*args, **kwargs):
        raise RuntimeError("could not build agent")
    monkeypatch.setattr(api, "_build_agent_for_room", broken_build_agent)

    result = asyncio.run(api._run_direct_answer_agent(
        "room-1", {"slug": "lead"}, "user-1", "org-1", None, "turn-1", "question", "context",
    ))

    assert result is None


def test_returns_none_when_agent_invocation_fails(monkeypatch):
    async def fake_build_agent(*args, **kwargs):
        async def broken_agent(msg):
            raise RuntimeError("model unreachable")
        return broken_agent
    monkeypatch.setattr(api, "_build_agent_for_room", fake_build_agent)

    result = asyncio.run(api._run_direct_answer_agent(
        "room-1", {"slug": "lead"}, "user-1", "org-1", None, "turn-1", "question", "context",
    ))

    assert result is None


def test_returns_none_for_an_empty_reply(monkeypatch):
    async def fake_build_agent(*args, **kwargs):
        async def agent(msg):
            return _FakeReply("   ")
        return agent
    monkeypatch.setattr(api, "_build_agent_for_room", fake_build_agent)

    result = asyncio.run(api._run_direct_answer_agent(
        "room-1", {"slug": "lead"}, "user-1", "org-1", None, "turn-1", "question", "context",
    ))

    assert result is None
