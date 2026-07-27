import asyncio
from copy import deepcopy

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


def test_permanent_campaign_room_debates_the_active_run_goal():
    director = object.__new__(Director)
    director.user_message = "Create a 14-day X awareness campaign for FOREST"
    director.room_goal = "Turn company truth into debated campaigns"
    director.room_kind = "campaign"

    assert director._debate_topic() == director.user_message


def test_x_awareness_campaign_does_not_turn_recalled_prospects_into_outreach():
    director = object.__new__(Director)
    director.user_message = "Create a brand-awareness campaign for X Organic"
    director.room_kind = "campaign"

    assert director._uses_prospect_debate(["x_organic"]) is False
    assert director._uses_prospect_debate(["gmail"]) is True


def test_campaign_recall_queries_reject_foreign_brand_identifiers():
    director = object.__new__(Director)
    director.company_brief = "Company: B&B. Markenagentur GmbH"
    director.user_message = "Build awareness for B&B among German brand leaders"

    assert director._campaign_recall_query_is_grounded("B&B target audience") is True
    assert director._campaign_recall_query_is_grounded("GDPR considerations for B2B X organic") is True
    assert director._campaign_recall_query_is_grounded("SINGULANCE x_organic channel capabilities") is False


def test_campaign_recall_does_not_trust_foreign_brand_in_company_brief():
    director = object.__new__(Director)
    director.company_brief = "B&B. Markenagentur GmbH. Imported notes mention SINGULANCE."
    director.user_message = "Build awareness for B&B. Markenagentur GmbH."
    director.campaign_brief = {"goal": "Build awareness for B&B. Markenagentur GmbH."}

    assert director._campaign_recall_query_is_grounded("B&B target audience") is True
    assert director._campaign_recall_query_is_grounded("SINGULANCE mission and products") is False


def test_campaign_compiler_normalizes_cta_aliases_without_regeneration():
    bundle = {
        "creative_system": {"hypotheses": [
            {"id": "h1", "call_to_action": "Follow for the next campaign chapter"},
            {"id": "h2"},
        ]},
        "actions": [
            {"hypothesis_id": "h2", "payload": {"cta": "Visit the campaign page"}},
        ],
    }

    Director._repair_campaign_derivations(bundle)

    assert bundle["creative_system"]["hypotheses"][0]["cta"] == "Follow for the next campaign chapter"
    assert bundle["creative_system"]["hypotheses"][1]["cta"] == "Visit the campaign page"


def test_campaign_compiler_replaces_unsupported_historical_baseline():
    bundle = {
        "kpis": [{"target_type": "proposed", "evidence_ids": []}],
        "monitoring_plan": {"baseline": "Historical organic reach is approximately 4,000 accounts."},
    }

    Director._repair_campaign_derivations(bundle)

    assert bundle["monitoring_plan"]["baseline"] == "Establish the campaign baseline from the first published action."


def test_campaign_compiler_replaces_unsupported_named_account_baseline():
    bundle = {
        "kpis": [{"target_type": "proposed", "evidence_ids": []}],
        "monitoring_plan": {"baseline": "Current X account average reach for similar posts."},
    }

    Director._repair_campaign_derivations(bundle)

    assert bundle["monitoring_plan"]["baseline"] == "Establish the campaign baseline from the first published action."


def test_campaign_contract_rejects_assumptions_in_executable_copy():
    bundle = _valid_v2_bundle()
    bundle["actions"][0]["claim_status"] = "assumption"
    bundle["actions"][0]["evidence_ids"] = []

    accepted, errors = campaign__submit_plan(
        bundle,
        channels=["x_organic"],
        requirements=["goal", "channel:x_organic"],
    )

    assert accepted is None
    assert any("cannot publish an assumption as final_copy" in error for error in errors)


def test_campaign_contract_rejects_numbers_and_absolutes_borrowing_unrelated_evidence():
    bundle = _valid_v2_bundle()
    bundle["actions"][0]["final_copy"] = "Campaign Rooms are always ready in 50 ms."
    bundle["actions"][0]["payload"]["text"] = bundle["actions"][0]["final_copy"]

    accepted, errors = campaign__submit_plan(
        bundle,
        channels=["x_organic"],
        requirements=["goal", "channel:x_organic"],
    )

    assert accepted is None
    assert any("claims not present in its evidence: 50 ms, always" in error for error in errors)


def _valid_v1_bundle():
    return {
        "strategy": "Build founder awareness with concise, grounded proof.",
        "audience": {"rationale": "Existing founder audience"},
        "content_pillars": ["AI coordination proof"],
        "kpis": [{"name": "Engagements", "target": "Establish baseline", "source": "X", "target_type": "baseline", "evidence_ids": []}],
        "actions": [{
            "id": "x-1",
            "channel": "x_organic",
            "title": "Campaign Room proof",
            "final_copy": "Run your company with an AI team that plans before it acts.",
            "payload": {"text": "Run your company with an AI team that plans before it acts."},
            "scheduled_offset_minutes": 0,
            "rationale": "Lead with the product outcome.",
            "format": "single_post",
            "creative_brief": {"required": True, "concept": "Show the campaign operating board."},
            "claim_status": "verified",
            "evidence_ids": ["evidence-1"],
            "hypothesis_id": "outcome-proof",
            "dependencies": ["Approved X connection"],
            "success_measure": "Establish an organic engagement baseline.",
            "rollback_or_exit": "Pause the remaining sequence if provider validation fails.",
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
        "strategy_options": [
            {"id": "proof", "name": "Proof led", "thesis": "Show the finished work.", "tradeoff": "Requires product evidence."},
            {"id": "speed", "name": "Speed led", "thesis": "Lead with coordination speed.", "tradeoff": "Avoid unsupported timing claims."},
            {"id": "control", "name": "Control led", "thesis": "Lead with approval and governance.", "tradeoff": "Less emotionally direct."},
        ],
        "selected_strategy_id": "proof",
        "company_grounding": {
            "company_name": "Singulance",
            "facts_used": ["Campaign Rooms return structured executable plans."],
            "unknowns": [],
        },
        "campaign_horizon": {"duration_days": 14, "intensity": "focused", "rationale": "Enough time to establish a baseline."},
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
        "evidence": [{"id": "evidence-1", "claim": "Campaign Rooms return structured plans.", "source": "Product workflow", "source_type": "company", "confidence": "high", "status": "verified", "url": ""}],
        "media_plan": {
            "currency": None,
            "channels": [{
                "channel": "x_organic", "role": "Organic awareness and message learning",
                "rationale": "The brief selects X for this campaign.", "budget_amount": 0,
                "prerequisites": ["Approved X connection"], "exclusions": ["No paid promotion"],
            }],
        },
        "creative_system": {
            "approved_claim_ids": ["evidence-1"],
            "hypotheses": [
                {"id": "outcome-proof", "insight": "Founders need completed work, not agent theatre.", "promise": "Show an approval-ready campaign plan.", "hook": "Run your company with an AI team.", "cta": "Inspect the result.", "channels": ["x_organic"], "experiment_hypothesis": "Outcome-led copy earns qualified engagement."},
                {"id": "control-proof", "insight": "Teams need control over external AI actions.", "promise": "Keep launch approval-bound.", "hook": "AI can plan without publishing.", "cta": "Review the operating model.", "channels": ["x_organic"], "experiment_hypothesis": "Control-led copy earns trust-oriented replies."},
            ],
        },
        "launch_plan": {
            "mode": "draft_only", "approval_mode": "APPROVE_PLAN_ONCE",
            "prerequisites": ["Confirm the connected X identity"], "blocked_by": [], "ceilings": [],
            "verification_steps": ["Read back the published Post"],
            "rollback_steps": ["Pause all remaining scheduled actions"],
        },
        "monitoring_plan": {
            "baseline": "Capture the pre-launch X account baseline.",
            "primary_outcome": "Qualified organic engagement",
            "attribution_limit": "Engagement does not prove revenue causation.",
            "checkpoints": [{"timing": "24 hours after each Post", "metrics": ["impressions", "engagements"], "decision_rule": "Review message resonance; do not auto-optimize."}],
            "optimization_requires_approval": True,
        },
        "quality_gate": {"ready": True, "checks": {
            "goal_alignment": "passed", "company_grounding": "passed", "channel_completeness": "passed",
            "provider_validity": "passed", "schedule_completeness": "passed", "evidence_integrity": "passed",
            "creative_completeness": "passed", "launch_safety": "passed", "measurement_readiness": "passed",
        }},
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
    assert "contract_version must be at least 4" in errors
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


def test_campaign_pace_requires_a_complete_sequence_not_one_sample():
    bundle = _valid_v2_bundle()
    brief = {"brief": {"duration_days": 14, "cadence": {
        "preset": "focused",
        "expected_actions_by_channel": {"x_organic": {"minimum": 6, "maximum": 8}},
    }}}
    accepted, errors = campaign__submit_plan(
        bundle,
        channels=["x_organic"],
        requirements=["goal", "channel:x_organic"],
        minimum_contract_version=CAMPAIGN_CONTRACT_VERSION,
        campaign_brief=brief,
    )
    assert accepted is None
    assert "channel x_organic needs 6-8 actions for this campaign pace; received 1" in errors

    complete = deepcopy(bundle)
    for index in range(2, 7):
        action = deepcopy(bundle["actions"][0])
        action["id"] = f"x-{index}"
        action["title"] = f"Campaign post {index}"
        action["scheduled_offset_minutes"] = (index - 1) * 1440
        complete["actions"].append(action)
        complete["timeline"].append({
            "action_id": action["id"], "phase": "sustain",
            "scheduled_offset_minutes": action["scheduled_offset_minutes"],
        })
        for row in complete["requirement_coverage"]:
            row["action_ids"].append(action["id"])
    accepted, errors = campaign__submit_plan(
        complete,
        channels=["x_organic"],
        requirements=["goal", "channel:x_organic"],
        minimum_contract_version=CAMPAIGN_CONTRACT_VERSION,
        campaign_brief=brief,
    )
    assert errors == []
    assert accepted is not None


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


def test_awareness_audience_does_not_trigger_places_discovery():
    director = Director(
        user_message="Create an awareness campaign for law firms",
        user_id="user", org_id="org", project_id=None, participants=[], room_template="auto",
        room_goal="Campaign", enabled_connectors=[], emit=lambda event: None,
        room_kind="campaign",
        campaign_brief={"goal": "Create an awareness campaign for law firms", "audiencePolicy": {"discover_if_insufficient": True}},
    )
    assert director._allows_places_discovery() is False


def test_campaign_places_discovery_requires_sourcing_intent_and_geography():
    director = Director(
        user_message="Find prospects",
        user_id="user", org_id="org", project_id=None, participants=[], room_template="auto",
        room_goal="Campaign", enabled_connectors=[], emit=lambda event: None,
        room_kind="campaign",
        campaign_brief={"goal": "Find law firm prospects in Berlin", "audiencePolicy": {"discover_if_insufficient": True}},
    )
    assert director._allows_places_discovery() is True


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
