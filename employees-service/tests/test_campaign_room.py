import asyncio
from copy import deepcopy

import pytest

from hivemind_employees.hyper.campaign_contract import (
    CAMPAIGN_CONTRACT_VERSION,
    assemble_campaign_bundle,
    campaign__submit_plan,
    classify_campaign_errors,
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


def test_semantic_campaign_plan_is_assembled_into_execution_contract():
    semantic = {
        "objective": "AWARENESS",
        "strategy": "Build trust with an evidence-led sequence.",
        "strategy_options": [
            {"id": "evidence", "name": "Evidence", "thesis": "Lead with proof", "tradeoff": "Slower hook"},
            {"id": "story", "name": "Story", "thesis": "Lead with narrative", "tradeoff": "Less technical"},
            {"id": "community", "name": "Community", "thesis": "Lead with participation", "tradeoff": "Needs engagement"},
        ],
        "selected_strategy_id": "evidence",
        "company_grounding": {"company_name": "Example", "facts_used": ["The event is on August 5"], "unknowns": []},
        "positioning": {"statement": "A practical event for design leaders.", "proof_points": ["Event date supplied by the user"]},
        "audience": {"rationale": "Design leaders", "segments": [{"name": "Design leaders"}], "safety_notes": []},
        "content_pillars": ["Practical design leadership"],
        "kpis": [{"name": "Engagement", "target": "Establish baseline", "source": "X", "target_type": "baseline", "evidence_ids": []}],
        "evidence": [{"id": "event", "claim": "The event is on August 5", "source": "User brief", "source_type": "user_brief", "status": "verified"}],
        "creative_system": {"approved_claim_ids": ["event"], "hypotheses": [
            {"id": "date", "insight": "Timing matters", "promise": "Plan ahead", "hook": "Save the date", "cta": "Follow updates", "channels": ["x_organic"], "experiment_hypothesis": "Date-led copy earns engagement"},
            {"id": "value", "insight": "Practical value matters", "promise": "Useful discussion", "hook": "What will you learn?", "cta": "Follow updates", "channels": ["x_organic"], "experiment_hypothesis": "Value-led copy earns engagement"},
        ]},
        "actions": [{"channel": "x_organic", "title": "Save the date", "final_copy": "Save the date for a practical conversation about design leadership.", "claim_status": "no_claim", "evidence_ids": [], "hypothesis_id": "date"}],
        "measurement": {"primary_kpi": "Engagement", "attribution_limit": "Engagement is not attendance.", "review_cadence": "After each post"},
        "debate_conflicts_present": False, "debate_decisions": [], "assumptions": [], "risks": [],
        "report_markdown": "## Recommendation\nBuild trust.\n## Audience\nDesign leaders.\n## Positioning\nPractical.\n## Content System\nEvidence.\n## Campaign Sequence\nOne post.\n## Schedule\nSeven days.\n## Measurement\nEngagement.\n## Risks\nNone.\n## Launch Readiness\nPending approval.",
    }
    bundle = assemble_campaign_bundle(
        semantic, channels=["x_organic"], requirements=["goal", "channel:x_organic"],
        campaign_brief={"objective": "AWARENESS", "autonomyMode": "FULL_AUTO", "brief": {"duration_days": 7, "cadence": {"preset": "focused"}}},
    )

    assert bundle["contract_version"] == CAMPAIGN_CONTRACT_VERSION
    assert bundle["evidence"][0]["source_type"] == "user"
    assert bundle["actions"][0]["payload"]["text"] == bundle["actions"][0]["final_copy"]
    assert bundle["timeline"][0]["action_id"] == bundle["actions"][0]["id"]
    assert bundle["monitoring_plan"]["optimization_requires_approval"] is False
    assert bundle["requirement_coverage"][1]["action_ids"] == [bundle["actions"][0]["id"]]
    accepted, errors = campaign__submit_plan(
        bundle, channels=["x_organic"], requirements=["goal", "channel:x_organic"],
        minimum_contract_version=CAMPAIGN_CONTRACT_VERSION,
        campaign_brief={"objective": "AWARENESS", "autonomyMode": "FULL_AUTO", "brief": {"duration_days": 7, "cadence": {"preset": "focused"}}},
    )
    assert errors == []
    assert accepted == bundle


def test_campaign_compiler_applies_authoritative_action_maximum():
    semantic = {
        "actions": [
            {"id": f"x-{index}", "channel": "x_organic", "final_copy": f"Post {index}"}
            for index in range(1, 8)
        ],
    }
    bundle = assemble_campaign_bundle(
        semantic, channels=["x_organic"], requirements=["goal", "channel:x_organic"],
        campaign_brief={"brief": {"duration_days": 7, "cadence": {
            "expected_actions_by_channel": {"x_organic": {"minimum": 4, "maximum": 6}},
        }}},
    )

    assert [action["id"] for action in bundle["actions"]] == [f"x-{index}" for index in range(1, 7)]
    assert len(bundle["timeline"]) == 6
    assert len(bundle["creative_system"]["hypotheses"]) == 2
    assert all(action["hypothesis_id"] for action in bundle["actions"])


def test_campaign_derivations_normalize_only_claim_safe_assumptions():
    bundle = {
        "company_grounding": {"facts_used": []},
        "positioning": {"statement": "Shared company memory.", "proof_points": []},
        "evidence": [{"id": "company-1", "status": "verified", "claim": "SINGULANCE has a company memory product."}],
        "actions": [
            {"id": "safe", "claim_status": "assumption", "final_copy": "Explore a shared company memory."},
            {"id": "outcome", "claim_status": "assumption", "final_copy": "Our customers improve performance."},
            {"id": "grounded", "claim_status": "assumption", "final_copy": "SINGULANCE has a company memory product.", "evidence_ids": ["company-1"]},
        ],
    }

    Director._repair_campaign_derivations(bundle)

    assert bundle["company_grounding"]["facts_used"] == ["SINGULANCE has a company memory product."]
    assert bundle["positioning"]["proof_points"] == ["SINGULANCE has a company memory product."]
    assert bundle["actions"][0]["claim_status"] == "no_claim"
    assert bundle["actions"][1]["claim_status"] == "assumption"
    assert bundle["actions"][2]["claim_status"] == "verified"


def test_campaign_report_accepts_explicitly_proposed_kpi_percentage():
    bundle = _valid_v2_bundle()
    bundle["kpis"][0].update({"target": "2% engagement rate", "target_type": "proposed"})
    bundle["report_markdown"] = bundle["report_markdown"].replace(
        "Establish a baseline.", "The campaign target is a 2% engagement rate.",
    )

    accepted, errors = campaign__submit_plan(
        bundle, channels=["x_organic"], requirements=["goal", "channel:x_organic"],
        minimum_contract_version=CAMPAIGN_CONTRACT_VERSION,
    )

    assert errors == []
    assert accepted is not None


def test_campaign_validation_errors_are_typed_for_targeted_repair():
    grouped = classify_campaign_errors([
        "action a1 dependencies must be an array for contract v4",
        "action a1 contains claims not present in its evidence: 30%",
        "Gmail action a1 needs a verified payload.to email",
    ])
    assert len(grouped["structural"]) == 1
    assert len(grouped["semantic"]) == 1
    assert len(grouped["operational"]) == 1


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


def test_campaign_recall_facts_must_name_the_active_company():
    director = object.__new__(Director)
    director.company_brief = "Company: B&B. Markenagentur GmbH\nMission: Human intuition plus AI."

    assert director._campaign_recall_fact_is_grounded("B&B. Markenagentur supports brand leaders") is True
    assert director._campaign_recall_fact_is_grounded("HiPeople is a Berlin prospect") is False
    assert director._campaign_recall_fact_is_grounded("Budget distribution totals EUR 162000") is False


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


def test_campaign_compiler_spans_a_multi_day_horizon():
    bundle = {
        "campaign_horizon": {"duration_days": 14},
        "actions": [
            {"id": "one", "scheduled_offset_minutes": 0},
            {"id": "two", "scheduled_offset_minutes": 1440},
            {"id": "three", "scheduled_offset_minutes": 2880},
        ],
        "timeline": [
            {"action_id": "one", "scheduled_offset_minutes": 0},
            {"action_id": "two", "scheduled_offset_minutes": 1440},
            {"action_id": "three", "scheduled_offset_minutes": 2880},
        ],
    }

    Director._repair_campaign_derivations(bundle)

    assert [action["scheduled_offset_minutes"] for action in bundle["actions"]] == [0, 9360, 18720]
    assert [row["scheduled_offset_minutes"] for row in bundle["timeline"]] == [0, 9360, 18720]


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


def test_campaign_contract_rejects_unsupplied_public_urls():
    bundle = _valid_v2_bundle()
    bundle["actions"][0]["claim_status"] = "no_claim"
    bundle["actions"][0]["evidence_ids"] = []
    bundle["actions"][0]["final_copy"] = "Read the case study: https://example.com/case"
    bundle["actions"][0]["payload"]["text"] = bundle["actions"][0]["final_copy"]

    accepted, errors = campaign__submit_plan(
        bundle,
        channels=["x_organic"],
        requirements=["goal", "channel:x_organic"],
    )

    assert accepted is None
    assert any("URL that was not supplied" in error for error in errors)


def test_campaign_contract_rejects_outcomes_disguised_as_no_claim():
    bundle = _valid_v2_bundle()
    bundle["actions"][0]["claim_status"] = "no_claim"
    bundle["actions"][0]["evidence_ids"] = []
    bundle["actions"][0]["final_copy"] = "How we helped a municipal agency refresh its brand."
    bundle["actions"][0]["payload"]["text"] = bundle["actions"][0]["final_copy"]

    accepted, errors = campaign__submit_plan(
        bundle,
        channels=["x_organic"],
        requirements=["goal", "channel:x_organic"],
    )

    assert accepted is None
    assert any("labeled no_claim" in error for error in errors)


def test_campaign_compiler_normalizes_outcome_claim_with_verified_evidence():
    bundle = _valid_v2_bundle()
    action = bundle["actions"][0]
    action["claim_status"] = "no_claim"
    action["final_copy"] = "Our platform helps legal teams coordinate campaign work."
    action["payload"]["text"] = action["final_copy"]

    Director._repair_campaign_derivations(bundle)

    assert action["claim_status"] == "verified"


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
        "report_markdown": "## Recommendation\nLead with proof.\n## Audience\nExisting founders.\n## Positioning\nApproval-ready campaign coordination.\n## Content System\nOutcome and control.\n## Campaign Sequence\nOne grounded post.\n## Schedule\nLaunch after approval.\n## Measurement\nEstablish a baseline.\n## Risks\nNo historical baseline.\n## Launch Readiness\nPending approval.",
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


def test_full_auto_campaign_contract_does_not_request_optimization_approval():
    bundle = _valid_v2_bundle()
    bundle["launch_plan"]["approval_mode"] = "FULL_AUTO"
    bundle["monitoring_plan"]["optimization_requires_approval"] = False
    accepted, errors = campaign__submit_plan(
        bundle,
        channels=["x_organic"],
        requirements=["goal", "channel:x_organic"],
        campaign_brief={"autonomyMode": "FULL_AUTO"},
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
        action["scheduled_offset_minutes"] = round(13 * 1440 * (index - 1) / 5)
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


def test_campaign_report_rejects_unsupported_performance_numbers():
    bundle = _valid_v2_bundle()
    bundle["report_markdown"] = bundle["report_markdown"].replace(
        "Establish a baseline.", "Customers improve performance by 30%.",
    )

    accepted, errors = campaign__submit_plan(
        bundle,
        channels=["x_organic"],
        requirements=["goal", "channel:x_organic"],
        minimum_contract_version=CAMPAIGN_CONTRACT_VERSION,
    )

    assert accepted is None
    assert "report_markdown contains an unsupported performance number: 30%" in errors


def test_campaign_report_does_not_expose_internal_method_library():
    bundle = _valid_v2_bundle()
    bundle["report_markdown"] += "\nClaude Ads selected the method."

    accepted, errors = campaign__submit_plan(
        bundle,
        channels=["x_organic"],
        requirements=["goal", "channel:x_organic"],
        minimum_contract_version=CAMPAIGN_CONTRACT_VERSION,
    )

    assert accepted is None
    assert "report_markdown must not expose internal method names" in errors


def test_campaign_report_sections_may_be_localized():
    bundle = _valid_v2_bundle()
    bundle["report_markdown"] = "\n".join([
        "## Recommandation\nConstruire la confiance.",
        "## Public\nDécideurs.",
        "## Positionnement\nPratique.",
        "## Contenu\nFondé sur les preuves.",
        "## Calendrier\nAprès approbation.",
        "## Mesure\nÉtablir une référence.",
    ])

    accepted, errors = campaign__submit_plan(
        bundle,
        channels=["x_organic"],
        requirements=["goal", "channel:x_organic"],
        minimum_contract_version=CAMPAIGN_CONTRACT_VERSION,
    )

    assert errors == []
    assert accepted is not None


def test_campaign_report_deterministically_includes_missing_final_actions():
    bundle = _valid_v2_bundle()
    report = Director._complete_campaign_report("## Strategy\nLead with evidence.", bundle)

    assert "## Final Actions" in report
    assert bundle["actions"][0]["final_copy"] in report
    assert "**Channel:** x_organic" in report


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


def test_campaign_synthesizer_submits_with_the_canonical_contract_version(monkeypatch):
    emitted = []

    async def emit(event):
        emitted.append(event)

    async def synthesize(*args, **kwargs):
        return {"content": "{}"}

    def accept(candidate, **kwargs):
        assert kwargs["minimum_contract_version"] == CAMPAIGN_CONTRACT_VERSION
        return candidate, []

    director = Director(
        user_message="Create an awareness campaign",
        user_id="user", org_id="org", project_id=None, participants=[], room_template="auto",
        room_goal="Campaign", enabled_connectors=[], emit=emit,
        room_kind="campaign", campaign_brief={"channels": ["x_organic"], "goal": "Build awareness"},
    )
    monkeypatch.setattr(director, "_groq", synthesize)
    monkeypatch.setattr("hivemind_employees.hyper.campaign_contract.campaign__submit_plan", accept)

    bundle, errors = asyncio.run(director._synthesize_campaign_bundle(False, ""))

    assert errors == []
    assert bundle["contract_version"] == CAMPAIGN_CONTRACT_VERSION
    assert emitted[-1] == {"t": "campaign_tool", "tool": "campaign__submit_plan", "status": "accepted"}


def test_visual_concept_does_not_force_a_second_full_synthesis(monkeypatch):
    calls = []

    async def emit(event):
        return None

    async def synthesize(*args, **kwargs):
        calls.append(kwargs)
        return {"content": '{"report_markdown":"Campaign report","plan":{"actions":[{"creative_brief":{"required":true,"concept":"A focused product scene","alt_text":"Product scene"}}]}}'}

    director = Director(
        user_message="Create an X awareness campaign",
        user_id="user", org_id="org", project_id=None, participants=[], room_template="auto",
        room_goal="Campaign", enabled_connectors=[], emit=emit,
        room_kind="campaign", campaign_brief={"channels": ["x_organic"], "goal": "Build awareness"},
    )
    monkeypatch.setattr(director, "_groq", synthesize)
    monkeypatch.setattr(
        "hivemind_employees.hyper.campaign_contract.campaign__submit_plan",
        lambda candidate, **kwargs: (candidate, []),
    )

    bundle, errors = asyncio.run(director._synthesize_campaign_bundle(False, ""))

    assert errors == []
    assert bundle["actions"][0]["creative_brief"]["concept"] == "A focused product scene"
    assert [call["model"] for call in calls] == [director.synth_model]
    assert calls[0]["json_object"] is True


def test_campaign_validation_repair_uses_compact_synthesis_context(monkeypatch):
    models = []
    message_sets = []
    submissions = 0

    async def emit(event):
        return None

    async def synthesize(*args, **kwargs):
        models.append(kwargs["model"])
        message_sets.append(args[0])
        if len(models) == 1:
            return {"content": '{"report_markdown":"Report","plan":{"strategy":"Initial"}}'}
        return {"content": '{"actions":[],"fields":{"strategy":"Repaired"},"report_markdown":"Report"}'}

    def submit(candidate, **kwargs):
        nonlocal submissions
        submissions += 1
        return (None, ["strategy needs repair"]) if submissions == 1 else (candidate, [])

    director = Director(
        user_message="Create an awareness campaign",
        user_id="user", org_id="org", project_id=None, participants=[], room_template="auto",
        room_goal="Campaign", enabled_connectors=[], emit=emit,
        room_kind="campaign", campaign_brief={"channels": ["x_organic"], "goal": "Build awareness"},
    )
    monkeypatch.setattr(director, "_groq", synthesize)
    monkeypatch.setattr("hivemind_employees.hyper.campaign_contract.campaign__submit_plan", submit)

    _, errors = asyncio.run(director._synthesize_campaign_bundle(False, ""))

    assert errors == []
    assert models == [director.synth_model, director.director_model]
    assert len(message_sets[1]) == 2
    assert "GATHERED BOARD" not in message_sets[1][1]["content"]
    assert "invalid_actions" in message_sets[1][1]["content"]
    assert "Initial" in message_sets[1][1]["content"]
    assert "report_markdown" not in message_sets[1][1]["content"]


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
