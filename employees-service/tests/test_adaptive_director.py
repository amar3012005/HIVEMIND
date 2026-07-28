import asyncio
import json

from hivemind_employees.hyper.engine import Director


def _director(*, message: str, room_kind: str = "general", company_brief: str = ""):
    events = []

    async def emit(event):
        events.append(event)

    director = Director(
        user_message=message,
        user_id="user-1",
        org_id="org-1",
        project_id=None,
        participants=[
            {"slug": "lead", "name": "Lead", "_lane": "Strategist"},
            {"slug": "researcher", "name": "Researcher", "_lane": "Investigator"},
            {"slug": "builder", "name": "Builder", "_lane": "Builder"},
        ],
        room_template="auto",
        room_goal="Standing specialist goal",
        enabled_connectors=[],
        emit=emit,
        room_kind=room_kind,
        company_brief=company_brief,
    )
    return director, events


def test_light_intensity_is_a_bounded_director_contract(monkeypatch):
    director, _events = _director(message="Can we run a campaign for law firms?")
    payload = {
        "recall_queries": ["law firms", "campaign history"],
        "connector_calls": [],
        "web_query": "law firm campaign benchmarks",
        "seo_audit_url": None,
        "places_query": None,
        "needs_debate": True,
        "method_skills": [],
        "campaign_method_assignments": [],
        "turn_mode": "task",
        "collaboration_intensity": "light",
        "response_depth": "operating",
        "evidence_mode": "standard",
        "campaign_request": None,
    }

    async def plan_call(*_args, **_kwargs):
        return {"content": json.dumps(payload)}

    monkeypatch.setattr(director, "_groq", plan_call)
    plan = asyncio.run(director._plan_gather())

    assert plan["collaboration_intensity"] == "light"
    assert plan["response_depth"] == "direct"
    assert plan["needs_debate"] is False
    assert len(plan["recall_queries"]) == 1


def test_seo_remediation_refreshes_measured_evidence_without_forcing_deep(monkeypatch):
    director, _events = _director(
        message="Resolve 4 critical and 0 high finding(s)",
        room_kind="seo",
        company_brief="Company: BB Markenagentur\nWebsite: https://bb-markenagentur.de/",
    )
    payload = {
        "recall_queries": ["previous SEO work"],
        "connector_calls": [],
        "web_query": None,
        "seo_audit_url": None,
        "places_query": None,
        "needs_debate": False,
        "method_skills": [],
        "campaign_method_assignments": [],
        "turn_mode": "task",
        "collaboration_intensity": "standard",
        "response_depth": "focused",
        "evidence_mode": "standard",
        "campaign_request": None,
    }

    async def plan_call(*_args, **_kwargs):
        return {"content": json.dumps(payload)}

    monkeypatch.setattr(director, "_groq", plan_call)
    plan = asyncio.run(director._plan_gather())

    assert plan["collaboration_intensity"] == "standard"
    assert plan["response_depth"] == "focused"
    assert plan["seo_audit_url"] == "https://bb-markenagentur.de/"
    assert plan["seo_audit_page_limit"] == 25
    assert plan["recall_queries"] == []
    assert plan["needs_debate"] is False


def test_light_collaboration_is_visible_without_persona_calls():
    director, events = _director(message="Can you give me a quick answer?")

    asyncio.run(director._emit_light_collaboration({
        "turn_mode": "task",
        "recall_queries": [],
        "connector_calls": [],
        "web_query": None,
        "seo_audit_url": None,
    }))

    contributions = [event for event in events if event.get("t") == "react"]
    assert len(contributions) == 3
    assert all(event.get("activity_only") is True for event in contributions)

