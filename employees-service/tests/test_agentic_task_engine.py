"""Agentic task engine (dual-engine, 2026-08-13, flag-gated
HYPER_AGENTIC_ENGINE): a real multi-step ReAct loop (lead agent + delegate_to
specialist sub-agents) the planner can route a turn to instead of the fixed
plan-once gather->debate->synth pipeline. `_run_agentic_task` is the seam
inside Director.run() — it must return None on ANY failure or empty result
so the caller falls through to the normal pipeline unchanged. This is the
"can only ADD behavior, never break a turn" contract.
"""
import asyncio

from hivemind_employees.hyper.engine import Director


def _director(*, agentic_task_hook=None, room_kind="general"):
    events = []

    async def emit(event):
        events.append(event)

    return Director(
        user_message="build me a one-page brochure", user_id="user-1", org_id="org-1",
        project_id=None, participants=[{"slug": "lead", "name": "Lead", "_lane": "Strategist"}],
        room_template="auto", room_goal="", enabled_connectors=[], emit=emit,
        room_kind=room_kind, intended_output="answer", agentic_task_hook=agentic_task_hook,
    ), events


def test_returns_none_when_no_hook_is_supplied():
    director, _ = _director(agentic_task_hook=None)
    result = asyncio.run(director._run_agentic_task({}, 0.0))
    assert result is None


def test_hook_text_becomes_the_final_result_dict():
    async def fake_hook(user_message, board_context):
        assert user_message == "build me a one-page brochure"
        return "The agent's real, multi-step, tool-grounded deliverable."

    director, events = _director(agentic_task_hook=fake_hook)
    result = asyncio.run(director._run_agentic_task({"outreach_request": None}, 0.0))

    assert result is not None
    assert result["final_text"] == "The agent's real, multi-step, tool-grounded deliverable."
    assert result["execution_engine"] == "agentic"
    assert result["turn_mode"] == "task"
    # The final line still emits, same shape every other synth path emits —
    # the FE renders this identically regardless of which engine produced it.
    assert any(e.get("t") == "line" and e.get("kind") == "synthesis" for e in events)


def test_empty_hook_reply_falls_through_to_none():
    async def empty_hook(user_message, board_context):
        return ""

    director, _ = _director(agentic_task_hook=empty_hook)
    assert asyncio.run(director._run_agentic_task({}, 0.0)) is None


def test_none_hook_reply_falls_through_to_none():
    async def none_hook(user_message, board_context):
        return None

    director, _ = _director(agentic_task_hook=none_hook)
    assert asyncio.run(director._run_agentic_task({}, 0.0)) is None


def test_hook_exception_falls_back_to_none_not_a_crash():
    async def broken_hook(user_message, board_context):
        raise RuntimeError("agent invocation failed")

    director, _ = _director(agentic_task_hook=broken_hook)
    assert asyncio.run(director._run_agentic_task({}, 0.0)) is None


def test_run_dispatches_to_agentic_engine_when_plan_selects_it(monkeypatch):
    """Full run() dispatch: execution_engine=='agentic' + a wired hook must
    short-circuit run() before the normal gather/debate/synth pipeline ever
    starts — this is the actual chokepoint the user asked for."""
    async def fake_hook(user_message, board_context):
        return "Agentic engine handled the whole turn."

    director, _ = _director(agentic_task_hook=fake_hook)

    async def fake_plan_gather():
        return {
            "execution_engine": "agentic", "turn_mode": "task",
            "recall_queries": [], "history_turns_back": 0, "connector_calls": [],
            "web_query": None, "seo_audit_url": None, "seo_audit_scope": None,
            "seo_task": None, "places_query": None, "needs_debate": False,
            "method_skills": [], "campaign_method_assignments": [], "work_orders": [],
            "collaboration_intensity": "standard", "response_depth": "focused",
            "evidence_mode": "standard", "post_output_actions": [],
            "outreach_request": None, "campaign_request": None,
        }
    monkeypatch.setattr(director, "_plan_gather", fake_plan_gather)
    monkeypatch.setattr(director, "_init_connector_tools", lambda: asyncio.sleep(0))
    monkeypatch.setattr(director, "_prefetch_runtime_prospects", lambda: asyncio.sleep(0))

    result = asyncio.run(director.run())
    assert result["final_text"] == "Agentic engine handled the whole turn."
    assert result["execution_engine"] == "agentic"


def test_run_never_routes_campaign_rooms_to_the_agentic_engine(monkeypatch):
    """Campaign rooms have their own structured contract/bundle governance
    with no analogue in the agentic engine — routing them there would skip
    that governance silently. Deterministic exclusion, not planner discretion."""
    called = {"hook": False}

    async def fake_hook(user_message, board_context):
        called["hook"] = True
        return "should never be reached for a campaign room"

    director, _ = _director(agentic_task_hook=fake_hook, room_kind="campaign")

    async def fake_plan_gather():
        return {
            "execution_engine": "agentic", "turn_mode": "task",
            "recall_queries": [], "history_turns_back": 0, "connector_calls": [],
            "web_query": None, "seo_audit_url": None, "seo_audit_scope": None,
            "seo_task": None, "places_query": None, "needs_debate": False,
            "method_skills": [], "campaign_method_assignments": [], "work_orders": [],
            "collaboration_intensity": "standard", "response_depth": "focused",
            "evidence_mode": "standard", "post_output_actions": [],
            "outreach_request": None, "campaign_request": None,
        }
    monkeypatch.setattr(director, "_plan_gather", fake_plan_gather)
    monkeypatch.setattr(director, "_init_connector_tools", lambda: asyncio.sleep(0))
    monkeypatch.setattr(director, "_prefetch_runtime_prospects", lambda: asyncio.sleep(0))

    # Campaign rooms raise inside _synthesize if actually reached without a
    # campaign bundle — that's fine here, it PROVES the agentic short-circuit
    # was skipped and the normal (campaign) path was entered instead.
    try:
        asyncio.run(director.run())
    except Exception:
        pass
    assert called["hook"] is False
