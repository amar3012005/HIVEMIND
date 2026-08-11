import pytest

from hivemind_employees.hyper import engine
from hivemind_employees.hyper.engine import Director


@pytest.mark.asyncio
async def test_non_campaign_room_can_delegate_to_campaign_tool(monkeypatch):
    events = []

    async def emit(event):
        events.append(event)

    director = Director(
        user_message="Run a two-week X awareness campaign for HIVEMIND",
        user_id="user-1", org_id="org-1", project_id=None,
        participants=[{"slug": "lead", "name": "Lead"}], room_template="debate",
        room_goal="Growth", enabled_connectors=[], emit=emit,
        room_kind="marketing", room_id="source-room", turn_id="source-turn",
    )

    async def no_tools():
        return None

    async def plan():
        return {
            "turn_mode": "task", "recall_queries": [], "connector_calls": [],
            "web_query": None, "places_query": None, "needs_debate": False,
            "method_skills": [],
            "campaign_request": {
                "goal": "Build awareness for HIVEMIND", "name": "HIVEMIND awareness",
                "objective": "AWARENESS", "channels": ["x_organic"],
                "duration_days": 14, "intensity": "FOCUSED",
                "autonomy_mode": "APPROVE_PLAN_ONCE",
            },
        }

    async def create(brief, **kwargs):
        assert kwargs["user_id"] == "user-1"
        assert kwargs["org_id"] == "org-1"
        assert kwargs["room_id"] == "source-room"
        assert kwargs["turn_id"] == "source-turn"
        assert brief["channels"] == ["x_organic"]
        return {"created": True, "campaign": {
            "id": "campaign-1", "roomId": "campaign-room-1",
            "status": "GENERATING", "name": "HIVEMIND awareness",
        }}

    async def no_usage(**_kwargs):
        return None

    monkeypatch.setattr(director, "_init_connector_tools", no_tools)
    monkeypatch.setattr(director, "_plan_gather", plan)
    monkeypatch.setattr(engine, "campaign_create_emulated", create)
    monkeypatch.setattr(engine, "report_llm_usage", no_usage)

    result = await director.run()
    assert result["campaign_handoff"]["campaign_id"] == "campaign-1"
    assert result["campaign_handoff"]["room_id"] == "campaign-room-1"
    assert result["tool_calls"] == 1
    assert any(event.get("t") == "campaign_handoff" for event in events)
    assert "Nothing has been published" in result["final_text"]


@pytest.mark.asyncio
async def test_campaign_tool_failure_is_a_terminal_honest_handoff(monkeypatch):
    events = []

    async def emit(event):
        events.append(event)

    director = Director(
        user_message="Run a campaign", user_id="user-1", org_id="org-1", project_id=None,
        participants=[{"slug": "lead"}], room_template="debate", room_goal="Growth",
        enabled_connectors=[], emit=emit, room_kind="marketing",
        room_id="source-room", turn_id="source-turn",
    )

    async def no_tools():
        return None

    async def plan():
        return {
            "turn_mode": "task", "recall_queries": [], "connector_calls": [], "web_query": None,
            "places_query": None, "needs_debate": False, "method_skills": [],
            "campaign_request": {"goal": "Run a campaign", "name": None, "objective": "CUSTOM",
                                 "channels": [], "duration_days": 14, "intensity": "FOCUSED",
                                 "autonomy_mode": "APPROVE_PLAN_ONCE"},
        }

    async def fail(*_args, **_kwargs):
        return {"error": "No campaign channel is ready", "code": "campaign_channel_required"}

    async def no_usage(**_kwargs):
        return None

    monkeypatch.setattr(director, "_init_connector_tools", no_tools)
    monkeypatch.setattr(director, "_plan_gather", plan)
    monkeypatch.setattr(engine, "campaign_create_emulated", fail)
    monkeypatch.setattr(engine, "report_llm_usage", no_usage)

    result = await director.run()
    assert result["campaign_handoff_error"] == "No campaign channel is ready"
    assert any(event.get("t") == "campaign_handoff_failed" for event in events)
    assert not any(event.get("t") == "campaign_handoff" for event in events)
