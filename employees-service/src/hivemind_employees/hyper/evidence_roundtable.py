"""Bounded, shadow-safe LangGraph protocol for Evidence Roundtable v1.

The graph exchanges public structured contributions only. It never stores or
broadcasts private chain-of-thought. Durable provider waits remain outside this
in-process graph and enter only as receipt-backed evidence callbacks.
"""
from __future__ import annotations

import asyncio
import hashlib
import re
import time
from typing import Any, Awaitable, Callable, Dict, Literal, Optional, TypedDict

from langgraph.graph import END, START, StateGraph


Consult = Callable[[Dict[str, Any], str], Awaitable[Dict[str, Any]]]
EvidenceRefill = Callable[[Dict[str, Any]], Awaitable[Dict[str, Any]]]
EventSink = Callable[[Dict[str, Any]], Awaitable[Any]]

_KINDS = {"position", "challenge", "support", "evidence_request", "revision", "abstain", "minority_report"}
_RESEARCH_ROUTES = {
    "playwright_extract", "governed_web_search", "parallel_findall", "parallel_task",
    "parallel_enrichment", "google_maps", "first_party_or_regulator",
}


class RoundtableState(TypedDict, total=False):
    contract: Dict[str, Any]
    common_context: Dict[str, Any]
    role_contexts: Dict[str, Dict[str, Any]]
    consult: Consult
    evidence_refill: Optional[EvidenceRefill]
    emit: EventSink
    contributions: list[Dict[str, Any]]
    claims: list[Dict[str, Any]]
    contradictions: list[Dict[str, Any]]
    evidence_requests: list[Dict[str, Any]]
    evidence_receipts: list[Dict[str, Any]]
    minority_report: Dict[str, Any]
    verdict: Dict[str, Any]
    synthesis_context: Dict[str, Any]
    stop_reason: str
    usage: Dict[str, Any]


def _identifier(prefix: str, *parts: str) -> str:
    digest = hashlib.sha256("\x1f".join(parts).encode("utf-8")).hexdigest()[:16]
    return f"{prefix}-{digest}"


def _tokens(value: str) -> set[str]:
    return {word for word in re.findall(r"[a-z0-9]{3,}", value.casefold())}


def _similarity(left: str, right: str) -> float:
    a, b = _tokens(left), _tokens(right)
    return len(a & b) / max(1, len(a | b))


def normalize_contribution(raw: Any, *, agent_id: str, role: str, ordinal: int) -> Dict[str, Any]:
    value = raw if isinstance(raw, dict) else {}
    statement = str(value.get("statement") or "").strip()[:1600]
    kind = str(value.get("kind") or "position").strip().lower()
    if kind not in _KINDS:
        kind = "position"
    requested = value.get("requested_action") if isinstance(value.get("requested_action"), dict) else None
    return {
        "contribution_id": str(value.get("contribution_id") or _identifier("contrib", agent_id, role, str(ordinal), statement)),
        "agent_id": agent_id, "role": role, "kind": kind,
        "target_claim_ids": [str(x)[:120] for x in (value.get("target_claim_ids") or []) if str(x).strip()][:8],
        "statement": statement,
        "evidence_refs": [str(x)[:240] for x in (value.get("evidence_refs") or []) if str(x).strip()][:12],
        "assumptions": [str(x)[:300] for x in (value.get("assumptions") or []) if str(x).strip()][:8],
        "confidence": max(0.0, min(1.0, float(value.get("confidence") or 0.0))),
        "information_gain": max(0.0, min(1.0, float(value.get("information_gain") or 0.0))),
        "changed_position": bool(value.get("changed_position")),
        "requested_action": requested,
        "duplicate": False,
    }


async def _prepare(state: RoundtableState) -> Dict[str, Any]:
    return {"contributions": [], "claims": [], "contradictions": [], "evidence_requests": [],
            "evidence_receipts": [], "minority_report": {}, "verdict": {}, "usage": {"consults": 0, "refills": 0}}


async def _blind_positions(state: RoundtableState) -> Dict[str, Any]:
    participants = [p for p in state["contract"].get("participants", []) if p.get("role") != "judge"]
    if state["contract"].get("mode") == "reviewer":
        participants = [p for p in participants if p.get("role") != "skeptic"][:1]

    async def run(index: int, participant: Dict[str, Any]) -> Dict[str, Any]:
        role, agent_id = str(participant.get("role")), str(participant.get("agent_id"))
        prompt = {
            "phase": "blind_position", "question": state["contract"].get("decision_question"),
            "critical_claims": state["contract"].get("critical_claims", []),
            "common_context": state.get("common_context", {}),
            "role_context": state.get("role_contexts", {}).get(role, {}),
            "rules": ["Do not infer peer positions", "Return public conclusions, not private reasoning",
                      "Every factual assertion must reference supplied evidence or be marked as an assumption"],
        }
        raw = await state["consult"](participant, str(prompt))
        item = normalize_contribution(raw, agent_id=agent_id, role=role, ordinal=index)
        item["contribution_id"] = _identifier(
            "contrib", str(state.get("common_context", {}).get("turn_id") or "turn"), "blind", agent_id,
        )
        await state["emit"]({"t": "blind_position", "round": 1, "shadow": True, **item})
        return item

    rows = await asyncio.gather(*(run(i, p) for i, p in enumerate(participants)))
    return {"contributions": rows, "usage": {"consults": len(rows), "refills": 0}}


async def _normalize_claims(state: RoundtableState) -> Dict[str, Any]:
    claims: list[Dict[str, Any]] = []
    threshold = float(state["contract"].get("stop_policy", {}).get("minimum_information_gain", 0.15))
    for item in state.get("contributions", []):
        duplicate_of = next((claim for claim in claims if _similarity(item["statement"], claim["statement"]) >= 0.82), None)
        if duplicate_of:
            item["duplicate"] = True
            item["information_gain"] = 0.0
        claim_id = _identifier("claim", item["contribution_id"])
        claim = {"claim_id": claim_id, "statement": item["statement"], "agent_id": item["agent_id"],
                 "evidence_refs": item["evidence_refs"], "assumptions": item["assumptions"],
                 "confidence": item["confidence"], "duplicate": item["duplicate"],
                 "resolved": bool(item["evidence_refs"]) and not item["assumptions"],
                 "risk": "high" if not item["evidence_refs"] or item["assumptions"] else "standard"}
        claims.append(claim)
        await state["emit"]({"t": "claim_normalized", "round": 1, "shadow": True,
                             "low_information": item["information_gain"] < threshold, **claim})
    return {"claims": claims, "contributions": state.get("contributions", [])}


def _route_after_normalize(state: RoundtableState) -> Literal["challenge", "judge"]:
    if state["contract"].get("mode") == "reviewer":
        return "challenge" if state.get("claims") else "judge"
    if state["contract"].get("mode") != "roundtable":
        return "judge"
    unresolved = [claim for claim in state.get("claims", []) if not claim.get("resolved") and not claim.get("duplicate")]
    return "challenge" if unresolved else "judge"


async def _targeted_challenge(state: RoundtableState) -> Dict[str, Any]:
    candidates = [c for c in state.get("claims", []) if not c.get("resolved") and not c.get("duplicate")]
    if not candidates and state["contract"].get("mode") == "reviewer":
        candidates = [c for c in state.get("claims", []) if not c.get("duplicate")]
    if not candidates:
        return {}
    target = sorted(candidates, key=lambda c: (c.get("risk") != "high", -float(c.get("confidence") or 0)))[0]
    skeptic = next((p for p in state["contract"].get("participants", []) if p.get("role") == "skeptic"),
                   {"agent_id": "skeptic", "role": "skeptic"})
    prompt = {"phase": "targeted_cross_examination", "question": state["contract"].get("decision_question"),
              "target_claim": target, "relevant_evidence": target.get("evidence_refs", []),
              "instruction": "Attack only this claim with a counterexample, logical defect, missing evidence, or discriminating test."}
    raw = await state["consult"](skeptic, str(prompt))
    item = normalize_contribution(raw, agent_id=str(skeptic.get("agent_id")), role="skeptic",
                                  ordinal=len(state.get("contributions", [])))
    item["contribution_id"] = _identifier(
        "contrib", str(state.get("common_context", {}).get("turn_id") or "turn"), "challenge",
        str(skeptic.get("agent_id")), target["claim_id"],
    )
    item["kind"] = "challenge"
    item["target_claim_ids"] = [target["claim_id"]]
    await state["emit"]({"t": "targeted_challenge", "round": 2, "shadow": True, **item})
    requests = []
    if item.get("requested_action"):
        requested = dict(item["requested_action"])
        route = str(requested.get("route") or "governed_web_search")
        requested["route"] = route if route in _RESEARCH_ROUTES else "governed_web_search"
        requested["external_effect"] = False
        request = {**requested, "request_id": _identifier("evidence", item["contribution_id"]),
                   "target_claim_id": target["claim_id"], "status": "requested"}
        requests.append(request)
        await state["emit"]({"t": "evidence_requested", "round": 2, "shadow": True, **request})
    return {"contributions": [*state.get("contributions", []), item], "evidence_requests": requests,
            "usage": {"consults": int(state.get("usage", {}).get("consults", 0)) + 1,
                      "refills": int(state.get("usage", {}).get("refills", 0))}}


async def _evidence_refill(state: RoundtableState) -> Dict[str, Any]:
    callback, budget = state.get("evidence_refill"), int(state["contract"].get("research_refill_budget") or 0)
    receipts = []
    for request in state.get("evidence_requests", [])[:budget]:
        if callback is None:
            receipt = {"request_id": request["request_id"], "status": "unavailable",
                       "evidence_refs": [], "reason": "shadow_provider_execution_disabled"}
        else:
            try:
                raw = await callback(request)
                receipt = {"request_id": request["request_id"], "status": str(raw.get("status") or "completed"),
                           "evidence_refs": list(raw.get("evidence_refs") or [])[:12],
                           "provider_receipt": raw.get("provider_receipt"), "reason": raw.get("reason")}
            except Exception as exc:  # provider failure remains an unresolved claim
                receipt = {"request_id": request["request_id"], "status": "failed", "evidence_refs": [],
                           "reason": str(exc)[:300]}
        receipts.append(receipt)
        await state["emit"]({"t": "evidence_received", "round": 2, "shadow": True, **receipt})
    usage = dict(state.get("usage", {})); usage["refills"] = len(receipts)
    return {"evidence_receipts": receipts, "usage": usage}


async def _revisions(state: RoundtableState) -> Dict[str, Any]:
    target = next((r.get("target_claim_id") for r in state.get("evidence_requests", [])), None)
    if not target:
        return {}
    original = next((c for c in state.get("claims", []) if c.get("claim_id") == target), {})
    participant = next((p for p in state["contract"].get("participants", []) if p.get("role") in {"domain_expert", "advocate"}), None)
    if not participant:
        return {}
    prompt = {"phase": "revision", "target_claim": original, "challenge": state.get("contributions", [])[-1],
              "evidence_receipts": state.get("evidence_receipts", []),
              "instruction": "Revise, narrow, or withdraw the claim. Failed or missing evidence is not proof."}
    raw = await state["consult"](participant, str(prompt))
    item = normalize_contribution(raw, agent_id=str(participant.get("agent_id")), role=str(participant.get("role")),
                                  ordinal=len(state.get("contributions", [])))
    item["contribution_id"] = _identifier(
        "contrib", str(state.get("common_context", {}).get("turn_id") or "turn"), "revision",
        str(participant.get("agent_id")), str(target),
    )
    item["kind"], item["changed_position"], item["target_claim_ids"] = "revision", True, [target]
    await state["emit"]({"t": "position_revised", "round": 2, "shadow": True, **item})
    usage = dict(state.get("usage", {})); usage["consults"] = int(usage.get("consults", 0)) + 1
    return {"contributions": [*state.get("contributions", []), item], "usage": usage}


async def _minority(state: RoundtableState) -> Dict[str, Any]:
    skeptic = next((p for p in state["contract"].get("participants", []) if p.get("role") == "skeptic"), None)
    if not skeptic:
        return {}
    prompt = {"phase": "minority_report", "question": state["contract"].get("decision_question"),
              "claims": state.get("claims", []), "evidence_receipts": state.get("evidence_receipts", []),
              "instruction": "State the strongest remaining objection, reversal evidence, downside risk, and required caveat."}
    raw = await state["consult"](skeptic, str(prompt))
    item = normalize_contribution(raw, agent_id=str(skeptic.get("agent_id")), role="skeptic",
                                  ordinal=len(state.get("contributions", [])))
    item["contribution_id"] = _identifier(
        "contrib", str(state.get("common_context", {}).get("turn_id") or "turn"), "minority",
        str(skeptic.get("agent_id")),
    )
    item["kind"] = "minority_report"
    await state["emit"]({"t": "minority_report", "round": 2, "shadow": True, **item})
    usage = dict(state.get("usage", {})); usage["consults"] = int(usage.get("consults", 0)) + 1
    return {"minority_report": item, "contributions": [*state.get("contributions", []), item], "usage": usage}


def _route_after_revision(state: RoundtableState) -> Literal["minority", "judge"]:
    return "judge" if state["contract"].get("mode") == "reviewer" else "minority"


async def _judge(state: RoundtableState) -> Dict[str, Any]:
    judge = next((p for p in state["contract"].get("participants", []) if p.get("role") == "judge"),
                 {"agent_id": "judge", "role": "judge", "model_profile": {"temperature": 0.1}})
    prompt = {"phase": "validity_judgment", "question": state["contract"].get("decision_question"),
              "claims": state.get("claims", []), "public_contributions": state.get("contributions", []),
              "evidence_receipts": state.get("evidence_receipts", []), "minority_report": state.get("minority_report", {}),
              "instruction": "Judge evidence validity, not majority agreement. Preserve unresolved dissent."}
    raw = await state["consult"](judge, str(prompt))
    valid_claim_ids = {c["claim_id"] for c in state.get("claims", [])}
    receipt_backed_ids = {c["claim_id"] for c in state.get("claims", []) if c.get("resolved")}
    accepted = sorted(receipt_backed_ids)
    unresolved = [c["claim_id"] for c in state.get("claims", []) if not c.get("resolved") and not c.get("duplicate")]
    verdict = raw if isinstance(raw, dict) else {}
    status = str(verdict.get("status") or ("accepted_with_caveat" if unresolved else "accepted"))
    if status not in {"accepted", "accepted_with_caveat", "refill_required", "user_decision_required", "failed"}:
        status = "accepted_with_caveat" if unresolved else "accepted"
    requested_accepted = {str(x) for x in (verdict.get("accepted_claim_ids") or accepted)}
    safe_accepted = sorted(requested_accepted & receipt_backed_ids)
    rejected = sorted({str(x) for x in (verdict.get("rejected_claim_ids") or [])} & valid_claim_ids)
    unresolved_ids = sorted(({str(x) for x in (verdict.get("unresolved_claim_ids") or unresolved)}
                             | (requested_accepted - receipt_backed_ids)) - set(rejected))
    if unresolved_ids and status == "accepted":
        status = "accepted_with_caveat"
    verdict = {
        "status": status, "accepted_claim_ids": safe_accepted,
        "rejected_claim_ids": rejected,
        "unresolved_claim_ids": unresolved_ids,
        "material_conflicts": list(verdict.get("material_conflicts") or []),
        "minority_objection": verdict.get("minority_objection") or state.get("minority_report", {}),
        "additional_round_required": False,
        "stop_reason": str(verdict.get("stop_reason") or ("bounded_rounds_complete" if unresolved else "critical_claims_verified")),
        "scores": {key: max(0.0, min(1.0, float((verdict.get("scores") or {}).get(key) or 0.0)))
                   for key in ("evidence_coverage", "source_independence", "contradiction_resolution", "decision_usefulness")},
    }
    await state["emit"]({"t": "roundtable_verdict", "round": 2, "shadow": True, "verdict": verdict})
    usage = dict(state.get("usage", {})); usage["consults"] = int(usage.get("consults", 0)) + 1
    return {"verdict": verdict, "stop_reason": verdict["stop_reason"], "usage": usage}


def _synthesis_context(state: RoundtableState) -> Dict[str, Any]:
    verdict = state.get("verdict", {})
    accepted = set(verdict.get("accepted_claim_ids") or [])
    return {"synthesis_context": {
        "accepted_claims": [c for c in state.get("claims", []) if c.get("claim_id") in accepted],
        "rejected_claim_ids": verdict.get("rejected_claim_ids", []),
        "unresolved_claim_ids": verdict.get("unresolved_claim_ids", []),
        "minority_objection": verdict.get("minority_objection", {}),
        "verdict": verdict,
    }}


def _build_graph():
    graph = StateGraph(RoundtableState)
    graph.add_node("prepare_shared_state", _prepare)
    graph.add_node("blind_positions", _blind_positions)
    graph.add_node("normalize_claims", _normalize_claims)
    graph.add_node("targeted_cross_examination", _targeted_challenge)
    graph.add_node("evidence_refill", _evidence_refill)
    graph.add_node("revisions", _revisions)
    graph.add_node("minority_report", _minority)
    graph.add_node("judge", _judge)
    graph.add_node("synthesis_context", _synthesis_context)
    graph.add_edge(START, "prepare_shared_state")
    graph.add_edge("prepare_shared_state", "blind_positions")
    graph.add_edge("blind_positions", "normalize_claims")
    graph.add_conditional_edges("normalize_claims", _route_after_normalize,
                                {"challenge": "targeted_cross_examination", "judge": "judge"})
    graph.add_edge("targeted_cross_examination", "evidence_refill")
    graph.add_edge("evidence_refill", "revisions")
    graph.add_conditional_edges("revisions", _route_after_revision,
                                {"minority": "minority_report", "judge": "judge"})
    graph.add_edge("minority_report", "judge")
    graph.add_edge("judge", "synthesis_context")
    graph.add_edge("synthesis_context", END)
    return graph.compile()


_ROUNDTABLE_GRAPH = _build_graph()


async def run_evidence_roundtable(*, contract: Dict[str, Any], common_context: Dict[str, Any],
                                  role_contexts: Dict[str, Dict[str, Any]], consult: Consult,
                                  emit: EventSink, evidence_refill: Optional[EvidenceRefill] = None,
                                  timeout_seconds: float = 120.0) -> Dict[str, Any]:
    if contract.get("version") != "debate_contract.v1":
        raise ValueError("debate_contract.v1 required")
    if contract.get("mode") == "none":
        return {"verdict": {"status": "accepted", "stop_reason": "debate_not_required"},
                "contributions": [], "claims": [], "synthesis_context": {}, "usage": {"consults": 0, "refills": 0}}
    started = time.monotonic()
    state = await asyncio.wait_for(_ROUNDTABLE_GRAPH.ainvoke({
        "contract": contract, "common_context": common_context, "role_contexts": role_contexts,
        "consult": consult, "evidence_refill": evidence_refill, "emit": emit,
    }), timeout=max(10.0, min(300.0, float(timeout_seconds))))
    # Never return callbacks, prompts, or full tenant context to persistence/API callers.
    return {
        "protocol_version": "evidence_roundtable.v1",
        "contributions": list(state.get("contributions") or []),
        "claims": list(state.get("claims") or []),
        "evidence_requests": list(state.get("evidence_requests") or []),
        "evidence_receipts": list(state.get("evidence_receipts") or []),
        "minority_report": dict(state.get("minority_report") or {}),
        "verdict": dict(state.get("verdict") or {}),
        "synthesis_context": dict(state.get("synthesis_context") or {}),
        "usage": dict(state.get("usage") or {}),
        "stop_reason": str(state.get("stop_reason") or ""),
        "duration_ms": int((time.monotonic() - started) * 1000),
    }
