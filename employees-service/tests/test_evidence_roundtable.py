import ast

import pytest

from hivemind_employees.hyper.evidence_roundtable import run_evidence_roundtable


def _contract(mode="roundtable"):
    roles = (["advocate", "skeptic"] if mode == "reviewer"
             else ["investigator", "domain_expert", "skeptic", "judge"])
    return {
        "version": "debate_contract.v1",
        "mode": mode,
        "decision_question": "Which strategy is safer?",
        "critical_claims": ["Strategy A is compliant"],
        "participants": [
            {"agent_id": role, "role": role, "model_profile": {"temperature": 0.1}}
            for role in roles
        ],
        "research_refill_budget": 2,
        "stop_policy": {"minimum_information_gain": 0.15},
    }


@pytest.mark.asyncio
async def test_blind_positions_do_not_receive_peer_conclusions_and_skeptic_is_targeted():
    prompts = []
    events = []

    async def consult(participant, prompt):
        payload = ast.literal_eval(prompt)
        prompts.append((participant["role"], payload))
        if payload["phase"] == "blind_position":
            return {
                "kind": "position",
                "statement": f"Independent {participant['role']} position",
                "evidence_refs": [],
                "assumptions": ["evidence missing"],
                "confidence": 0.7,
                "information_gain": 0.7,
            }
        if payload["phase"] == "targeted_cross_examination":
            return {
                "kind": "challenge",
                "statement": "The highest-risk claim lacks regulator evidence.",
                "confidence": 0.9,
                "information_gain": 0.8,
                "requested_action": {"route": "governed_web_search", "query": "regulator evidence"},
            }
        if payload["phase"] == "revision":
            return {"kind": "revision", "statement": "The claim remains unverified.", "confidence": 0.2}
        if payload["phase"] == "minority_report":
            return {"kind": "minority_report", "statement": "Do not publish the compliance claim.", "confidence": 0.95}
        return {
            "status": "accepted_with_caveat",
            "unresolved_claim_ids": [c["claim_id"] for c in payload["claims"] if not c["resolved"]],
            "minority_objection": {"statement": "Do not publish the compliance claim."},
            "stop_reason": "bounded_unresolved_claim",
            "scores": {"evidence_coverage": 0.0, "source_independence": 0.0,
                       "contradiction_resolution": 0.5, "decision_usefulness": 0.8},
        }

    async def emit(event):
        events.append(event)

    async def refill(_request):
        return {"status": "failed", "evidence_refs": [], "reason": "provider timeout"}

    result = await run_evidence_roundtable(
        contract=_contract(), common_context={"company": "Acme"},
        role_contexts={role: {"pack": role} for role in ("investigator", "domain_expert", "skeptic")},
        consult=consult, emit=emit, evidence_refill=refill,
    )

    blind = [payload for _role, payload in prompts if payload["phase"] == "blind_position"]
    assert len(blind) == 3
    assert all("public_contributions" not in payload and "peer" not in payload for payload in blind)
    challenges = [event for event in events if event["t"] == "targeted_challenge"]
    assert len(challenges) == 1
    assert len(challenges[0]["target_claim_ids"]) == 1
    assert result["verdict"]["status"] == "accepted_with_caveat"
    assert result["verdict"]["unresolved_claim_ids"]
    assert result["verdict"]["minority_objection"]
    verdict_event = next(event for event in events if event["t"] == "roundtable_verdict")
    assert "converged" not in verdict_event


@pytest.mark.asyncio
async def test_repeated_contribution_is_labeled_and_no_refill_when_all_claims_are_receipted():
    events = []

    async def consult(participant, prompt):
        payload = ast.literal_eval(prompt)
        if payload["phase"] == "blind_position":
            return {"kind": "position", "statement": "The verified claim is supported by receipt one.",
                    "evidence_refs": ["receipt-1"], "confidence": 0.8, "information_gain": 0.7}
        return {"status": "accepted", "accepted_claim_ids": [c["claim_id"] for c in payload["claims"]],
                "stop_reason": "critical_claims_verified", "scores": {}}

    async def emit(event):
        events.append(event)

    result = await run_evidence_roundtable(
        contract=_contract(), common_context={}, role_contexts={}, consult=consult, emit=emit,
    )
    normalized = [event for event in events if event["t"] == "claim_normalized"]
    assert len(normalized) == 3
    assert sum(bool(event["duplicate"]) for event in normalized) == 2
    assert not any(event["t"] == "evidence_requested" for event in events)
    assert result["usage"]["refills"] == 0


@pytest.mark.asyncio
async def test_none_mode_has_no_calls_or_events():
    async def forbidden(*_args):
        raise AssertionError("none mode must not execute")

    result = await run_evidence_roundtable(
        contract=_contract("none"), common_context={}, role_contexts={}, consult=forbidden, emit=forbidden,
    )
    assert result["usage"] == {"consults": 0, "refills": 0}


@pytest.mark.asyncio
async def test_reviewer_mode_has_one_maker_and_one_targeted_reviewer():
    phases = []

    async def consult(participant, prompt):
        payload = ast.literal_eval(prompt)
        phases.append((participant["role"], payload["phase"]))
        if payload["phase"] == "blind_position":
            return {"kind": "position", "statement": "Draft email", "assumptions": ["tone"],
                    "confidence": 0.6, "information_gain": 0.8}
        if payload["phase"] == "targeted_cross_examination":
            return {"kind": "challenge", "statement": "The call to action is ambiguous.",
                    "confidence": 0.9, "information_gain": 0.8}
        return {"status": "accepted_with_caveat", "stop_reason": "review_complete", "scores": {}}

    async def emit(_event):
        return None

    contract = _contract("reviewer")
    result = await run_evidence_roundtable(
        contract=contract, common_context={}, role_contexts={}, consult=consult, emit=emit,
    )
    assert phases.count(("advocate", "blind_position")) == 1
    assert ("skeptic", "blind_position") not in phases
    assert phases.count(("skeptic", "targeted_cross_examination")) == 1
    assert not any(phase == "minority_report" for _role, phase in phases)
    assert result["verdict"]["accepted_claim_ids"] == []


@pytest.mark.asyncio
async def test_judge_cannot_accept_receiptless_claim():
    async def consult(participant, prompt):
        payload = ast.literal_eval(prompt)
        if payload["phase"] == "blind_position":
            return {"kind": "position", "statement": f"Unsupported {participant['role']} claim",
                    "confidence": 0.8, "information_gain": 0.8}
        if payload["phase"] == "targeted_cross_examination":
            return {"kind": "challenge", "statement": "Missing proof", "confidence": 0.9}
        if payload["phase"] == "minority_report":
            return {"kind": "minority_report", "statement": "Remain cautious", "confidence": 0.9}
        if payload["phase"] == "revision":
            return {"kind": "revision", "statement": "Still unsupported", "confidence": 0.2}
        return {"status": "accepted", "accepted_claim_ids": [c["claim_id"] for c in payload["claims"]],
                "stop_reason": "majority_agreed", "scores": {}}

    async def emit(_event):
        return None

    result = await run_evidence_roundtable(
        contract=_contract(), common_context={}, role_contexts={}, consult=consult, emit=emit,
    )
    assert result["verdict"]["accepted_claim_ids"] == []
    assert result["verdict"]["unresolved_claim_ids"]
    assert result["verdict"]["status"] == "accepted_with_caveat"
