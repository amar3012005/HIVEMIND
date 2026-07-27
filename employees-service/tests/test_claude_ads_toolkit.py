import asyncio
from pathlib import Path

from hivemind_employees.hyper import claude_ads_toolkit
from hivemind_employees.hyper.engine import Director


def test_campaign_toolkit_searches_metadata_and_loads_only_allowlisted_files(tmp_path, monkeypatch):
    root = tmp_path / "claude-ads"
    skill = root / "skills" / "ads-plan" / "SKILL.md"
    skill.parent.mkdir(parents=True)
    skill.write_text('---\nname: ads-plan\ndescription: "Build campaign strategy and media plans."\n---\n# Plan\nUse evidence.', encoding="utf-8")
    ignored = root / "secrets.txt"
    ignored.write_text("never load", encoding="utf-8")
    monkeypatch.setenv("CLAUDE_ADS_RESOURCE_ROOT", str(root))
    claude_ads_toolkit._catalog.cache_clear()

    loaded = claude_ads_toolkit.load_assignments([
        {"role": "Strategist", "task": "Choose the strategy", "query": "campaign strategy media plan"},
    ])

    assert [row["resource"] for row in loaded] == ["skills/ads-plan/SKILL.md"]
    assert "Use evidence" in loaded[0]["body"]
    assert all(Path(row["resource"]).name != "secrets.txt" for row in loaded)


def test_campaign_toolkit_bounds_resources_per_role_and_run(tmp_path, monkeypatch):
    root = tmp_path / "claude-ads"
    for index in range(10):
        path = root / "agents" / f"campaign-{index}.md"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"# Campaign specialist {index}\nCampaign strategy planning.", encoding="utf-8")
    monkeypatch.setenv("CLAUDE_ADS_RESOURCE_ROOT", str(root))
    claude_ads_toolkit._catalog.cache_clear()

    loaded = claude_ads_toolkit.load_assignments([
        {"role": f"Role {index}", "task": "Campaign strategy", "query": "campaign strategy"}
        for index in range(8)
    ])

    assert len(loaded) <= 8
    assert len([row for row in loaded if row["role"] == "Role 0"]) <= 2


def test_campaign_room_emits_user_safe_skill_event(tmp_path, monkeypatch):
    root = tmp_path / "claude-ads"
    skill = root / "skills" / "launch-plan" / "SKILL.md"
    skill.parent.mkdir(parents=True)
    skill.write_text("# Launch planning\nSequence a product launch.", encoding="utf-8")
    monkeypatch.setenv("CLAUDE_ADS_RESOURCE_ROOT", str(root))
    claude_ads_toolkit._catalog.cache_clear()
    events = []

    async def emit(event):
        events.append(event)

    director = Director(
        user_message="Launch a product", user_id="user", org_id="org", project_id=None,
        participants=[], room_template="auto", room_goal="Campaign", enabled_connectors=[],
        emit=emit, room_kind="campaign", campaign_brief={"channels": ["x_organic"]},
    )
    count = asyncio.run(director._run_gather({
        "method_skills": [], "recall_queries": [], "connector_calls": [], "web_query": "",
        "places_query": "", "campaign_method_assignments": [{
            "role": "Strategist", "task": "Plan the product launch", "query": "launch planning",
        }],
    }))

    assert count == 1
    assert any(event.get("t") == "campaign_method_used" for event in events)
    skill_event = next(event for event in events if event.get("t") == "skill_used")
    assert skill_event["skill"] == "Plan the product launch"
    assert skill_event["source"] == "campaign_toolkit"
