import asyncio
import json
from types import SimpleNamespace

from scripts.director_plan_probe import probe


def _args(tmp_path, fixture_plan):
    fixture = tmp_path / "plan.json"
    fixture.write_text(json.dumps(fixture_plan), encoding="utf-8")
    return SimpleNamespace(
        request="Find regulated companies near Hannover and prepare drafts.",
        live=False,
        fixture_plan=str(fixture),
        company_brief="Company: Example GmbH\nLocation: Hannover",
        company_brief_file="",
        connectors="gmail",
        room_kind="general",
        room_mode="work",
        room_goal="",
        model="",
        user_id="user-1",
        org_id="org-1",
        project_id="",
    )


def test_probe_returns_the_normalized_director_decision_without_running_work(tmp_path):
    fixture_plan = {
        "recall_queries": ["regulated companies Hannover", "existing lead book"],
        "connector_calls": [],
        "web_query": None,
        "seo_audit_url": None,
        "seo_audit_scope": "none",
        "seo_task": "none",
        "places_query": "regulated companies in Hannover",
        "needs_debate": True,
        "method_skills": [],
        "campaign_method_assignments": [],
        "work_orders": [],
        "turn_plan": [],
        "turn_mode": "task",
        "collaboration_intensity": "standard",
        "response_depth": "focused",
        "evidence_mode": "prospecting",
        "post_output_actions": [],
        "outreach_request": None,
        "campaign_request": None,
    }

    result = asyncio.run(probe(_args(tmp_path, fixture_plan)))

    assert result["probe_contract"] == "director-plan-probe.v1"
    assert result["decision"]["places_query"] == "regulated companies in Hannover"
    assert result["decision"]["collaboration_intensity"] == "standard"
    assert result["decision"]["response_depth"] == "focused"
    assert result["metrics"]["tokens"] == 0
    assert result["events"] == []
