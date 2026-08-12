"""Every turn's final text — direct answer or artifact — used to come from
Director's own tool-less _synthesize(): a single plain-text call with no live
tool access, no progressive skill loading beyond whatever gather pre-fetched
upfront. Ask 2026-08-12: route response_depth=="direct" plain-answer turns to
a real tool-using agent (recall, connectors, live and on-demand) instead,
same reach a produce/artifact turn's agent already gets. Narrow by design:
artifact/produce turns and anything needing debate are completely untouched;
only the plain-answer + direct-depth case is affected, and only when the
caller explicitly supplies direct_answer_hook (None by default).
"""
import asyncio

from hivemind_employees.hyper.engine import Director


def _director(*, intended_output="answer", direct_answer_hook=None):
    events = []

    async def emit(event):
        events.append(event)

    return Director(
        user_message="what's our biggest risk?", user_id="user-1", org_id="org-1",
        project_id=None, participants=[{"slug": "lead", "name": "Lead", "_lane": "Strategist"}],
        room_template="auto", room_goal="", enabled_connectors=[], emit=emit,
        room_kind="general", intended_output=intended_output, direct_answer_hook=direct_answer_hook,
    ), events


def _set_depth(director, depth):
    # response_depth isn't a constructor param (it's planner-decided at runtime);
    # set it directly the same way _plan_gather's result would.
    director.response_depth = depth
    return director


def test_hook_answer_is_used_when_depth_is_direct_and_output_is_answer():
    async def fake_hook(user_message, board_context):
        assert user_message == "what's our biggest risk?"
        return "The agent's real, tool-grounded answer."

    director, _ = _director(direct_answer_hook=fake_hook)
    _set_depth(director, "direct")

    result = asyncio.run(director._try_direct_answer_hook())
    assert result == "The agent's real, tool-grounded answer."


def test_returns_none_when_response_depth_is_not_direct():
    async def fake_hook(user_message, board_context):
        raise AssertionError("must never be called when depth != direct")

    director, _ = _director(direct_answer_hook=fake_hook)
    _set_depth(director, "focused")

    assert asyncio.run(director._try_direct_answer_hook()) is None


def test_returns_none_when_intended_output_is_not_a_plain_answer():
    async def fake_hook(user_message, board_context):
        raise AssertionError("must never be called for an artifact-producing turn")

    director, _ = _director(intended_output="email", direct_answer_hook=fake_hook)
    _set_depth(director, "direct")

    assert asyncio.run(director._try_direct_answer_hook()) is None


def test_returns_none_when_no_hook_is_supplied():
    director, _ = _director(direct_answer_hook=None)
    _set_depth(director, "direct")

    assert asyncio.run(director._try_direct_answer_hook()) is None


def test_hook_exception_falls_back_to_none_not_a_crash():
    async def broken_hook(user_message, board_context):
        raise RuntimeError("agent invocation failed")

    director, _ = _director(direct_answer_hook=broken_hook)
    _set_depth(director, "direct")

    assert asyncio.run(director._try_direct_answer_hook()) is None


def test_hook_returning_none_or_empty_falls_back_to_none():
    async def empty_hook(user_message, board_context):
        return None

    async def blank_hook(user_message, board_context):
        return "   "

    director, _ = _director(direct_answer_hook=empty_hook)
    _set_depth(director, "direct")
    assert asyncio.run(director._try_direct_answer_hook()) is None

    director2, _ = _director(direct_answer_hook=blank_hook)
    _set_depth(director2, "direct")
    assert asyncio.run(director2._try_direct_answer_hook()) is None


def test_default_construction_never_touches_the_hook_path():
    # No direct_answer_hook passed at all — must be None, matching the
    # constructor default, so every existing caller is completely unaffected.
    director, _ = _director()
    assert director.direct_answer_hook is None
