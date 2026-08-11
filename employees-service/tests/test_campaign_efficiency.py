import json

import pytest

from hivemind_employees import api_hyper_rooms


def test_campaign_acceptance_requires_bundle_without_governance_errors():
    bundle = {"contract_version": 5}

    assert api_hyper_rooms._campaign_result_accepted({
        "campaign_bundle": bundle,
        "campaign_bundle_errors": [],
    }) is True
    assert api_hyper_rooms._campaign_result_accepted({
        "campaign_bundle": bundle,
        "campaign_bundle_errors": ["channel instagram needs 6-8 actions; received 4"],
    }) is False
    assert api_hyper_rooms._campaign_result_accepted({"campaign_bundle": bundle}) is False


def test_campaign_turn_skips_generic_journal_and_follow_up_generation():
    source = __import__("inspect").getsource(api_hyper_rooms._orchestrate_single_agent)

    assert 'if _room_kind != "campaign":\n        try:\n            _journal_entry' in source
    assert 'status == "complete" and _room_kind != "campaign"' in source


def _employee(employee_id, lane, *, name=None, persona=""):
    return {
        "id": employee_id,
        "slug": employee_id,
        "name": name or employee_id.title(),
        "_lane": lane,
        "persona": persona,
    }


def test_campaign_roster_uses_exactly_three_distinct_primary_roles():
    participants = [
        _employee("sales", "Communicator"),
        _employee("review", "Skeptic"),
        _employee("ops", "Builder"),
        _employee("strategy", "Strategist"),
        _employee("research", "Researcher"),
    ]

    roster = api_hyper_rooms._campaign_primary_roster(participants)

    assert len(roster) == 3
    assert len({employee["id"] for employee in roster}) == 3
    assert [employee["_campaign_role"] for employee in roster] == [
        "strategist", "creative_lead", "critical_reviewer",
    ]
    assert [employee["_lane"] for employee in roster] == [
        "Strategist", "Builder", "Skeptic",
    ]
    assert roster[0]["id"] == "strategy"
    assert roster[2]["id"] == "review"


def test_campaign_roster_does_not_mutate_room_participants():
    participants = [
        _employee("strategy", "Strategist"),
        _employee("creative", "Communicator"),
        _employee("review", "Skeptic"),
    ]

    roster = api_hyper_rooms._campaign_primary_roster(participants)

    assert "_campaign_role" not in participants[0]
    assert participants[1]["_lane"] == "Communicator"
    assert roster[1]["_lane"] == "Builder"


def test_campaign_roster_requires_all_three_roles_to_run():
    with pytest.raises(ValueError, match="at least three"):
        api_hyper_rooms._campaign_primary_roster([
            _employee("strategy", "Strategist"),
            _employee("review", "Skeptic"),
        ])


def test_campaign_debate_defaults_to_proposal_and_peer_challenge_rounds():
    assert api_hyper_rooms._campaign_debate_rounds({
        "goal": "Introduce the product",
        "brief": {"brand_constraints": "Accurate and concise"},
    }) == 2


@pytest.mark.parametrize("brief", [
    {"strategic_conflicts": ["awareness versus conversion"]},
    {"brief": {"strategy_conflicts": {"message": "technical versus accessible"}}},
    {"risks": ["regulated audience"]},
    {"brief": {"risk_flags": ["unverified claim"]}},
    {"brief": {"prohibited_claims": "Guaranteed growth"}},
])
def test_campaign_debate_adds_decision_round_for_declared_conflict_or_risk(brief):
    assert api_hyper_rooms._campaign_debate_rounds(brief) == 3


def test_campaign_models_use_direct_120b_by_default(monkeypatch):
    monkeypatch.delenv("HYPER_CAMPAIGN_GATHER_MODEL", raising=False)
    monkeypatch.delenv("HYPER_CAMPAIGN_DEBATE_MODEL", raising=False)
    monkeypatch.delenv("HYPER_CAMPAIGN_SYNTH_MODEL", raising=False)

    assert api_hyper_rooms._campaign_models() == (
        "gpt-oss-120b",
        "gpt-oss-120b",
        "gpt-oss-120b",
    )


def test_campaign_director_receives_bounded_round_policy(monkeypatch):
    captured = {}

    class FakeDirector:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    monkeypatch.setattr(api_hyper_rooms, "Director", FakeDirector)
    result = api_hyper_rooms._build_campaign_director(
        {"room_kind": "campaign", "synth_model": "gpt-oss-120b"},
        {"brief": {"prohibited_claims": "Guaranteed results"}},
    )

    assert isinstance(result, FakeDirector)
    assert captured["room_kind"] == "campaign"
    assert captured["synth_model"] == "gpt-oss-120b"
    assert captured["debate_max_rounds"] == 3


def test_campaign_turn_uses_one_orchestration_round(monkeypatch):
    monkeypatch.setenv("HYPER_ROOM_GOALKEEPER_MAX_ROUNDS", "5")

    assert api_hyper_rooms._goalkeeper_rounds_for_room("campaign") == 1
    assert api_hyper_rooms._goalkeeper_rounds_for_room("general") == 5
    assert api_hyper_rooms._goalkeeper_rounds_for_room("outreach", work_order=True) == 1
    assert api_hyper_rooms._is_hq_work_order_context('{"contract":"hq-work-order.v2"}') is True
    assert api_hyper_rooms._is_hq_work_order_context('{"contract":"hq-work-order.v1"}') is True
    assert api_hyper_rooms._is_hq_work_order_context('{"contract":"campaign-plan.v2"}') is False


def test_runtime_retry_owner_is_structured_not_version_string_dependent(monkeypatch):
    monkeypatch.setenv("HYPER_ROOM_GOALKEEPER_MAX_ROUNDS", "5")
    runtime = json.dumps({
        "contract": "future-envelope.v9",
        "retry_policy": {"owner": "playbook", "stage_attempt": 2, "max_stage_attempts": 3},
    })
    phase = json.dumps({
        "contract": "room-phase.v99",
        "lifecycle": {"retry_policy": {"owner": "playbook"}},
    })
    human = json.dumps({"contract": "work-room-turn.v1"})

    assert api_hyper_rooms._execution_retry_owner(runtime) == "playbook"
    assert api_hyper_rooms._execution_retry_owner(phase) == "playbook"
    assert api_hyper_rooms._is_hq_work_order_context(runtime) is True
    assert api_hyper_rooms._is_hq_work_order_context(phase) is True
    assert api_hyper_rooms._is_hq_work_order_context(human) is False
    assert api_hyper_rooms._goalkeeper_rounds_for_room("general", work_order=False) == 5
    assert api_hyper_rooms._execution_attempt_budget(runtime) == (2, 3)
    assert api_hyper_rooms._goalkeeper_rounds_for_room(
        "general", work_order=True, execution_context=runtime) == 1


def test_runtime_envelope_caps_room_rounds_without_changing_human_rooms(monkeypatch):
    monkeypatch.setenv("HYPER_ROOM_GOALKEEPER_MAX_ROUNDS", "5")
    first = json.dumps({
        "contract": "room-phase.v2", "attempt": 1, "max_attempts": 4,
        "lifecycle": {"retry_policy": {"owner": "playbook"}},
    })
    final = json.dumps({
        "contract": "runtime-stage.v1", "attempt": 4, "max_attempts": 4,
        "retry_policy": {"owner": "playbook"},
    })
    assert api_hyper_rooms._goalkeeper_rounds_for_room(
        "general", work_order=True, execution_context=first) == 3
    assert api_hyper_rooms._goalkeeper_rounds_for_room(
        "general", work_order=True, execution_context=final) == 1
    assert api_hyper_rooms._goalkeeper_rounds_for_room("general") == 5
