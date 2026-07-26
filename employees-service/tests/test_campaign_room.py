from hivemind_employees.hyper.engine import Director
from hivemind_employees.hyper.campaign_contract import campaign__submit_plan
from hivemind_employees.hyper.skills import resolve_room_kind


def test_campaign_task_tag_routes_to_dedicated_room_kind():
    assert resolve_room_kind("CAMPAIGN", "", "write some posts") == "campaign"


def test_campaign_bundle_cannot_pass_as_generic_report():
    channels = ["gmail", "tara"]
    requirements = ["goal", "channel:gmail", "channel:tara"]
    generic = {"strategy": "A polished report with no executable actions."}
    errors = Director._campaign_bundle_errors(generic, channels, requirements)
    assert "actions must not be empty" in errors
    assert "selected channel gmail has no action" in errors
    assert "requirement goal is not covered by actions" in errors


def test_campaign_submit_plan_is_the_completion_contract():
    accepted, errors = campaign__submit_plan(
        {"strategy": "Only prose"},
        channels=["x_organic"],
        requirements=["goal", "channel:x_organic"],
    )
    assert accepted is None
    assert "actions must not be empty" in errors


def test_tara_campaign_action_requires_speak_first_opening():
    bundle = {
        "strategy": "Call opted-in leads.",
        "audience": {"rationale": "Existing leads"},
        "content_pillars": ["Proof"],
        "kpis": [{"name": "Calls", "target": "baseline", "source": "TARA"}],
        "actions": [{
            "id": "call-1", "channel": "tara", "title": "Call", "final_copy": "Contract",
            "payload": {"to": "+49123456789"}, "scheduled_offset_minutes": 0,
            "rationale": "Immediate follow-up",
        }],
        "requirement_coverage": [
            {"requirement_id": "goal", "action_ids": ["call-1"]},
            {"requirement_id": "channel:tara", "action_ids": ["call-1"]},
        ],
    }
    errors = Director._campaign_bundle_errors(bundle, ["tara"], ["goal", "channel:tara"])
    assert any("speak-first" in error for error in errors)
