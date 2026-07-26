import asyncio

import pytest

from hivemind_employees.hyper.campaign_contract import (
    CAMPAIGN_CONTRACT_VERSION,
    campaign__submit_plan,
)
from hivemind_employees.hyper.engine import Director
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
    assert "requirement goal is not covered by valid actions" in errors


def test_campaign_submit_plan_is_the_completion_contract():
    accepted, errors = campaign__submit_plan(
        {"strategy": "Only prose"},
        channels=["x_organic"],
        requirements=["goal", "channel:x_organic"],
    )
    assert accepted is None
    assert "actions must not be empty" in errors


def _valid_v1_bundle():
    return {
        "strategy": "Build founder awareness with concise, grounded proof.",
        "audience": {"rationale": "Existing founder audience"},
        "content_pillars": ["AI coordination proof"],
        "kpis": [{"name": "Engagements", "target": "Establish baseline", "source": "X"}],
        "actions": [{
            "id": "x-1",
            "channel": "x_organic",
            "title": "Campaign Room proof",
            "final_copy": "Run your company with an AI team that plans before it acts.",
            "payload": {"text": "Run your company with an AI team that plans before it acts."},
            "scheduled_offset_minutes": 0,
            "rationale": "Lead with the product outcome.",
        }],
        "requirement_coverage": [
            {"requirement_id": "goal", "action_ids": ["x-1"]},
            {"requirement_id": "channel:x_organic", "action_ids": ["x-1"]},
        ],
    }


def _valid_v2_bundle():
    return {
        **_valid_v1_bundle(),
        "contract_version": CAMPAIGN_CONTRACT_VERSION,
        "objective": "Build awareness among founders.",
        "positioning": {
            "statement": "Singulance coordinates AI teams into approval-ready campaigns.",
            "proof_points": ["Dedicated Campaign Rooms return structured executable plans."],
        },
        "audience": {
            "rationale": "Existing founder audience",
            "segments": [{"name": "Solo founders", "need": "Coordinated execution"}],
            "safety_notes": ["Do not claim measured growth without evidence."],
        },
        "timeline": [{"action_id": "x-1", "phase": "Launch", "scheduled_offset_minutes": 0}],
        "safety": {
            "guardrails": ["Use only verified company claims."],
            "prohibited_claims": ["Guaranteed growth"],
        },
        "measurement": {
            "primary_kpi": "Engagements",
            "attribution_limit": "Organic engagement does not prove revenue causation.",
            "review_cadence": "Review after 24 hours.",
        },
        "debate_conflicts_present": True,
        "debate_decisions": [{
            "conflict": "Product detail versus concise awareness copy",
            "decision": "Lead with the outcome and reserve mechanics for follow-up content.",
            "rationale": "The audience needs a clear first impression.",
            "dissent": "The reviewer preferred naming the structured contract.",
        }],
        "assumptions": ["The connected X identity is approved before launch."],
        "launch_checklist": ["Confirm final copy and connected X identity."],
        "risks": ["No performance baseline exists yet."],
    }


def test_v1_campaign_bundles_remain_backward_compatible():
    accepted, errors = campaign__submit_plan(
        _valid_v1_bundle(),
        channels=["x_organic"],
        requirements=["goal", "channel:x_organic"],
    )
    assert errors == []
    assert accepted is not None


def test_new_campaign_compilation_requires_v2_operating_sections():
    accepted, errors = campaign__submit_plan(
        _valid_v1_bundle(),
        channels=["x_organic"],
        requirements=["goal", "channel:x_organic"],
        minimum_contract_version=CAMPAIGN_CONTRACT_VERSION,
    )
    assert accepted is None
    assert "contract_version must be at least 2" in errors
    assert "positioning.statement is required for contract v2" in errors
    assert "timeline must not be empty for contract v2" in errors
    assert "measurement.primary_kpi is required for contract v2" in errors


def test_v2_campaign_contract_accepts_complete_operating_plan():
    accepted, errors = campaign__submit_plan(
        _valid_v2_bundle(),
        channels=["x_organic"],
        requirements=["goal", "channel:x_organic"],
        minimum_contract_version=CAMPAIGN_CONTRACT_VERSION,
    )
    assert errors == []
    assert accepted == _valid_v2_bundle()


def test_x_posts_must_fit_provider_limit_and_threads_use_separate_actions():
    bundle = _valid_v2_bundle()
    bundle["actions"][0]["final_copy"] = "x" * 281
    bundle["actions"][0]["payload"]["text"] = "x" * 281
    accepted, errors = campaign__submit_plan(
        bundle,
        channels=["x_organic"],
        requirements=["goal", "channel:x_organic"],
        minimum_contract_version=CAMPAIGN_CONTRACT_VERSION,
    )
    assert accepted is None
    assert any("280 characters or fewer" in error for error in errors)


def test_x_post_payload_must_match_user_visible_final_copy():
    bundle = _valid_v2_bundle()
    bundle["actions"][0]["payload"]["text"] = "Different provider text"
    accepted, errors = campaign__submit_plan(
        bundle,
        channels=["x_organic"],
        requirements=["goal", "channel:x_organic"],
        minimum_contract_version=CAMPAIGN_CONTRACT_VERSION,
    )
    assert accepted is None
    assert any("must match final_copy" in error for error in errors)


def test_v2_campaign_records_debate_decisions_when_conflicts_exist():
    bundle = _valid_v2_bundle()
    bundle["debate_decisions"] = []
    accepted, errors = campaign__submit_plan(
        bundle,
        channels=["x_organic"],
        requirements=["goal", "channel:x_organic"],
        minimum_contract_version=CAMPAIGN_CONTRACT_VERSION,
    )
    assert accepted is None
    assert "debate_decisions must record every material conflict" in errors


def test_v2_timeline_must_match_executable_action_schedule():
    bundle = _valid_v2_bundle()
    bundle["timeline"][0]["scheduled_offset_minutes"] = 60
    accepted, errors = campaign__submit_plan(
        bundle,
        channels=["x_organic"],
        requirements=["goal", "channel:x_organic"],
        minimum_contract_version=CAMPAIGN_CONTRACT_VERSION,
    )
    assert accepted is None
    assert "timeline offset for action x-1 must match its action offset" in errors


def test_campaign_system_prompt_overrides_generic_report_completion():
    director = Director(
        user_message="Create an awareness campaign\nCHANNELS: x_organic",
        user_id="user", org_id="org", project_id=None, participants=[], room_template="auto",
        room_goal="Campaign", enabled_connectors=[], emit=lambda event: None,
        room_kind="campaign", campaign_brief={"goal": "Build awareness"},
    )
    prompt = director._system_prompt()
    assert "CAMPAIGN ROOM SYSTEM CONTRACT" in prompt
    assert "campaign__submit_plan" in prompt
    assert "generic final_report" in prompt


def test_campaign_room_cannot_call_generic_synthesis():
    director = Director(
        user_message="Create an awareness campaign\nCHANNELS: x_organic",
        user_id="user", org_id="org", project_id=None, participants=[], room_template="auto",
        room_goal="Campaign", enabled_connectors=[], emit=lambda event: None,
        room_kind="campaign", campaign_brief={"goal": "Build awareness"},
    )
    with pytest.raises(RuntimeError, match="campaign__submit_plan"):
        asyncio.run(director._synthesize(False, ""))


def test_campaign_audience_policy_blocks_machine_prose_from_triggering_places():
    director = Director(
        user_message='AUDIENCE_POLICY_JSON: {"discover_if_insufficient": false} run a company campaign',
        user_id="user", org_id="org", project_id=None, participants=[], room_template="auto",
        room_goal="Campaign", enabled_connectors=[], emit=lambda event: None,
        room_kind="campaign",
        campaign_brief={"goal": "Build awareness with founders", "audiencePolicy": {"discover_if_insufficient": False}},
    )
    assert director._allows_places_discovery() is False


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
