from hivemind_employees.hyper.grok_runtime import (
    agent_instance_id,
    build_roster_manifest,
    mode_at_least,
    normalize_runtime_mode,
    select_active_agents,
)


def _employee(employee_id: str, slug: str, lane: str):
    return {"id": employee_id, "slug": slug, "name": slug.title(), "_lane": lane, "tools": []}


def test_unknown_mode_fails_closed_and_modes_are_cumulative():
    assert normalize_runtime_mode("FUTURE") == "off"
    assert mode_at_least("real_tools", "persistent_agents") is True
    assert mode_at_least("shadow_roster", "durable_assignments") is False


def test_agent_identity_is_stable_and_does_not_expose_tenant_ids():
    value = agent_instance_id("org-secret", "employee-secret", 2)
    assert value == agent_instance_id("org-secret", "employee-secret", 2)
    assert "org-secret" not in value
    assert "employee-secret" not in value


def test_selector_uses_real_roster_lanes_without_task_keyword_routing():
    roster = [
        _employee("1", "lead", "Strategist"),
        _employee("2", "research", "Researcher"),
        _employee("3", "review", "Skeptic"),
        _employee("4", "writer", "Communicator"),
    ]
    selected = select_active_agents(roster, [
        {"owner_lane": "Researcher"}, {"owner_lane": "Skeptic"},
    ], lead_id="1", maximum=3)
    assert [row["id"] for row in selected] == ["1", "2", "3"]
    assert len(build_roster_manifest(roster, "org")) == 4
