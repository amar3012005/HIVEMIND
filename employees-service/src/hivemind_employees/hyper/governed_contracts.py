"""Deterministic, room-neutral contracts for governed HyperAgents work.

The Director supplies semantic intent.  This module turns that intent into small,
versioned capability and research contracts without performing provider calls or
granting authority.  The same functions are used by every room kind.
"""
from __future__ import annotations

import os
from typing import Any, Dict, Iterable, List, Optional


TASK_SKILL_VERSIONS = {
    "prospect.discovery": "1.0.0",
    "prospect.qualification": "1.0.0",
    "research.web": "1.0.0",
    "research.compliance": "1.0.0",
    "business.email": "1.0.0",
    "cold.email": "1.0.0",
    "cold.call": "1.0.0",
    "poster.art-direction": "1.0.0",
    "investor.deck": "1.0.0",
    "financial.projections": "1.0.0",
}

OUTPUT_SKILLS = {
    family: {"id": f"output.{family}.v1", "version": "1.0.0"}
    for family in ("text", "report", "presentation", "document", "spreadsheet", "image", "data")
}

_METHOD_TO_TASK_SKILL = {
    "prospect-qualification": "prospect.qualification",
    "cold-email": "cold.email",
    "cold-call": "cold.call",
    "investor-deck": "investor.deck",
    "financial-projections": "financial.projections",
    "compliance-research": "research.compliance",
}


def _unique(values: Iterable[str], limit: int = 12) -> List[str]:
    return list(dict.fromkeys(value for value in values if value))[:limit]


def build_task_skills(plan: Dict[str, Any], output_family: str) -> List[Dict[str, str]]:
    """Resolve a bounded immutable skill set from structured plan fields."""
    skill_ids = [_METHOD_TO_TASK_SKILL.get(str(name), "") for name in plan.get("method_skills") or []]
    prospecting = plan.get("outreach_request")
    if isinstance(prospecting, dict) and any(bool(prospecting.get(key)) for key in ("discover", "persist", "draft", "deliver", "monitor")):
        skill_ids.extend(["prospect.discovery", "prospect.qualification"])
        if prospecting.get("draft") or prospecting.get("deliver"):
            skill_ids.append("cold.email")
        if prospecting.get("call"):
            skill_ids.append("cold.call")
    if plan.get("web_query") or plan.get("seo_audit_url") or plan.get("extract_urls"):
        skill_ids.append("research.web")
    if output_family == "presentation":
        skill_ids.append("investor.deck")
    elif output_family == "image":
        skill_ids.append("poster.art-direction")
    if output_family in {"report", "presentation", "document"} and plan.get("research_floor"):
        skill_ids.append("research.compliance")
    return [{"id": skill_id, "version": TASK_SKILL_VERSIONS[skill_id]} for skill_id in _unique(skill_ids)]


_REVIEW_RANK = {"none": 0, "reviewer": 1, "roundtable": 2}
_MAKER_OUTPUTS = {"email", "doc", "document", "sheet", "spreadsheet", "report", "slides", "presentation", "artifact"}
_HIGH_RISK_KINDS = {"legal_finance", "fundraising", "strategy", "decision", "product", "branding"}
_ROLE_PROFILES = {
    "investigator": (0.15, "citation-first", ("source_ledger", "first_party", "independent")),
    "domain_expert": (0.35, "implications", ("company", "domain", "source_ledger")),
    "advocate": (0.60, "alternatives", ("company", "market", "source_ledger")),
    "skeptic": (0.50, "counterexample", ("independent", "regulator", "source_ledger")),
    "judge": (0.10, "validity", ("claim_ledger", "source_ledger", "room_policy")),
}


def build_debate_contract(*, plan: Dict[str, Any], participants: List[Dict[str, Any]],
                          user_message: str, room_kind: str, intended_output: str,
                          execution_profile: Optional[Dict[str, Any]] = None,
                          room_instructions: str = "") -> Dict[str, Any]:
    """Build the risk-triggered debate envelope without granting tool authority."""
    profile = execution_profile if isinstance(execution_profile, dict) else {}
    reasons: List[str] = []
    requested = "none"
    turn_mode = str(plan.get("turn_mode") or "task").lower()
    output = str(intended_output or "answer").lower()
    profile_review = str(profile.get("review_policy") or "none").lower()
    if profile_review == "debate":
        profile_review = "roundtable"
    if profile_review in _REVIEW_RANK and _REVIEW_RANK[profile_review] > _REVIEW_RANK[requested]:
        requested = profile_review
        reasons.append(f"execution_profile:{profile_review}")
    if turn_mode != "chat" and output in _MAKER_OUTPUTS:
        requested = max((requested, "reviewer"), key=_REVIEW_RANK.get)
        reasons.append("maker_output_requires_review")
    if bool(plan.get("needs_debate")):
        requested = "roundtable"
        reasons.append("director_requires_debate")
    evidence_mode = str(plan.get("evidence_mode") or "standard").strip().lower()
    risk_markers = [
        str(plan.get("research_floor") or ""),
        evidence_mode if evidence_mode in {"strict", "high", "compliance", "regulated"} else "",
        " ".join(str(x) for x in (plan.get("research_claims") or [])),
    ]
    if room_kind in _HIGH_RISK_KINDS and any(value.strip() for value in risk_markers):
        requested = "roundtable"
        reasons.append("high_risk_claims")
    lowered = str(user_message or "").casefold()
    if any(token in lowered for token in ("debate", "round table", "roundtable", "challenge this", "argue both sides")):
        requested = "roundtable"
        reasons.append("explicit_roundtable_request")
    if any(token in lowered for token in ("prove ", "only ", "gdpr", "compliance", "legal", "financial projection")):
        requested = "roundtable"
        reasons.append("consequential_public_claim")
    instruction = str(room_instructions or "").casefold()
    if "require debate" in instruction or "require roundtable" in instruction:
        requested = "roundtable"
        reasons.append("room_policy_requires_roundtable")
    elif "require review" in instruction and _REVIEW_RANK[requested] < _REVIEW_RANK["reviewer"]:
        requested = "reviewer"
        reasons.append("room_policy_requires_review")

    critical_claims = _unique([
        str(value).strip()[:240] for value in (
            list(plan.get("research_claims") or [])
            + [claim for order in (plan.get("turn_plan") or plan.get("work_orders") or [])
               if isinstance(order, dict) for claim in (order.get("required_evidence") or [])]
        ) if str(value).strip()
    ], 12)
    assigned = [p for p in participants if isinstance(p, dict) and (p.get("slug") or p.get("id"))]
    if requested == "roundtable":
        roles = (["investigator", "domain_expert", "skeptic", "judge"] if len(assigned) >= 4
                 else ["investigator", "skeptic", "judge"] if len(assigned) >= 3 else [])
        blocked_reason = None if roles else "at_least_three_assigned_digital_employees_required"
    elif requested == "reviewer":
        roles = ["advocate", "skeptic"] if len(assigned) >= 2 else []
        blocked_reason = None if roles else "at_least_two_assigned_digital_employees_required"
    else:
        roles, blocked_reason = [], None
    roster = []
    for index, role in enumerate(roles):
        temp, lens, evidence = _ROLE_PROFILES[role]
        employee = assigned[index]
        roster.append({
            "agent_id": str(employee.get("slug") or employee.get("id") or role),
            "employee_id": str(employee.get("id") or ""),
            "employee_name": str(employee.get("name") or employee.get("slug") or ""),
            "role": role, "lens": lens, "evidence_access": list(evidence),
            "model_profile": {"route": "cloudflare_ai_gateway_openrouter", "temperature": temp},
        })
    runtime_mode = str(os.environ.get("HYPER_EVIDENCE_ROUNDTABLE_MODE", "off")).strip().lower()
    if runtime_mode not in {"off", "shadow"}:
        runtime_mode = "off"
    return {
        "version": "debate_contract.v1", "mode": requested,
        "trigger_reasons": _unique(reasons, 8),
        "decision_question": str(user_message or "")[:600],
        "critical_claims": critical_claims,
        "participants": roster[:4], "max_rounds": 2, "max_agents": 4,
        "research_refill_budget": 2,
        "execution_blocked_reason": blocked_reason,
        "stop_policy": {"critical_claims_verified": True, "no_material_conflict": True,
                        "minimum_information_gain": 0.15, "max_stagnant_rounds": 1},
        "execution_mode": runtime_mode,
        "shadow": runtime_mode == "shadow",
    }


def normalize_prospecting_request(value: Any) -> Optional[Dict[str, Any]]:
    """Accept prospect work in any room while keeping all external effects explicit."""
    if not isinstance(value, dict):
        return None
    active = any(bool(value.get(key)) for key in ("discover", "persist", "draft", "deliver", "monitor", "call"))
    if not active:
        return None
    raw_count = value.get("requested_count")
    # A single named-recipient email is one action, not an implicit ten-lead
    # campaign. Keep the broader default only for actual discovery work.
    count = (
        max(1, min(50, int(raw_count))) if raw_count is not None
        else 10 if value.get("discover") else 1
    )
    return {
        "requested_count": count,
        "entity_type": str(value.get("entity_type") or "companies").strip().lower()[:40],
        "geography": str(value.get("geography") or "").strip()[:160] or None,
        "sector": str(value.get("sector") or "").strip()[:240] or None,
        "audience": str(value.get("audience") or "").strip()[:240] or None,
        "offer": str(value.get("offer") or "").strip()[:240] or None,
        "known_entities": [str(item).strip()[:240] for item in (value.get("known_entities") or []) if str(item).strip()][:50],
        "discover": bool(value.get("discover")),
        "persist": bool(value.get("persist")),
        "draft": bool(value.get("draft")),
        "deliver": bool(value.get("deliver")),
        "call": bool(value.get("call")),
        "monitor": bool(value.get("monitor")),
    }


def select_research_route(*, prospecting: Optional[Dict[str, Any]], known_urls: List[str],
                          deep_research: bool, places_available: bool,
                          parallel_available: bool, web_available: bool) -> Dict[str, Any]:
    """Choose one primary and bounded fallback lane from typed facts only."""
    reason = "no_external_research"
    primary = "none"
    fallbacks: List[str] = []
    if known_urls:
        primary, reason = "playwright_extract", "known_urls_require_source_faithful_extraction"
        if web_available:
            fallbacks.append("composio_web_search")
    elif prospecting:
        geography = str(prospecting.get("geography") or "").strip().casefold()
        anywhere = geography in {"", "anywhere", "global", "worldwide", "any location"}
        known = bool(prospecting.get("known_entities"))
        if known and parallel_available:
            primary, reason = "parallel_enrichment", "known_entities_need_structured_enrichment"
        elif not anywhere and places_available:
            primary, reason = "google_maps", "physical_business_search_has_explicit_geography"
            if parallel_available:
                fallbacks.append("parallel_findall")
        elif parallel_available:
            primary, reason = "parallel_findall", "cross_geography_structured_entity_discovery"
        elif web_available:
            primary, reason = "composio_web_search", "structured_entity_provider_unavailable"
    elif deep_research and parallel_available:
        primary, reason = "parallel_task", "multi_hop_structured_research"
        if web_available:
            fallbacks.append("composio_web_search")
    elif web_available:
        primary, reason = "composio_web_search", "focused_public_web_research"
    return {"primary": primary, "fallbacks": fallbacks[:1], "reason": reason}


def build_prospecting_contract(*, plan: Dict[str, Any], room_kind: str, room_mode: str,
                               room_instructions: str, known_urls: List[str],
                               places_available: bool, web_available: bool,
                               deep_research: bool) -> Optional[Dict[str, Any]]:
    request = normalize_prospecting_request(plan.get("outreach_request"))
    if not request:
        return None
    mode = str(os.environ.get("HYPER_PROSPECT_WORKFLOW_MODE", "shadow")).strip().lower()
    if mode not in {"off", "shadow", "canary", "primary"}:
        mode = "shadow"
    parallel_available = str(os.environ.get("HYPER_PARALLEL_COMPOSIO_ENABLED", "1")).lower() not in {"0", "false", "off", "no"}
    route = select_research_route(
        prospecting=request, known_urls=known_urls, deep_research=deep_research,
        places_available=places_available, parallel_available=parallel_available,
        web_available=web_available,
    )
    effects_requested = [name for name in ("persist", "deliver", "call", "monitor") if request.get(name)]
    return {
        "contract": "prospecting_contract.v1",
        "mode": mode,
        "scope": "room_policy",
        "room_policy": {
            "room_kind": room_kind,
            "room_mode": room_mode,
            "owner_instructions_present": bool(str(room_instructions or "").strip()),
            "external_effects_allowed": mode == "primary",
        },
        "request": request,
        "research_route": route,
        "stages": ["admit", "discover", "normalize", "verify", "enrich", "qualify", "persist_receipt", "prepare_outreach", "approval", "provider_receipt", "compare"],
        "governance": {
            "effects_requested": effects_requested,
            "drafts_are_editable": True,
            "approval_required": bool(request.get("deliver") or request.get("call")),
            "shadow_side_effects": False,
            "idempotency_scope": "org.room.turn.prospect.channel",
        },
    }
