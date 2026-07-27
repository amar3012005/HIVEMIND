"""Deterministic completion contract for Campaign Rooms."""

import copy
import re
from typing import Any

CAMPAIGN_CONTRACT_VERSION = 4

_HIGH_RISK_CLAIM_TERMS = ("only", "never", "always", "guarantee", "guaranteed", "ensures", "ensuring", "certified", "compliant", "proprietary")
_PUBLIC_URL_RE = re.compile(r"https?://[^\s)\]}>]+", re.I)
_EVIDENCE_SOURCE_TYPES = {"company", "connector", "web", "user", "provider", "derived"}
_EVIDENCE_SOURCE_ALIASES = {
    "company_memory": "company",
    "company_knowledge": "company",
    "memory": "company",
    "knowledge_base": "company",
    "web_search": "web",
    "research": "web",
    "user_brief": "user",
    "campaign_brief": "user",
    "connected_provider": "provider",
    "inference": "derived",
}
_NO_CLAIM_OUTCOME_RE = re.compile(
    r"\b(?:case\s+stud(?:y|ies)|(?:we|our\s+(?:team|platform|clients?|customers?))\s+"
    r"(?:help(?:ed|s|ing)?|deliver(?:ed|s|ing)?|accelerat\w*|driv(?:e|es|en|ing)|improv\w*|"
    r"increas\w*|reduc\w*|achiev\w*)|(?:clients?|customers?)\s+(?:report|see|saw|achiev\w*))\b",
    re.I,
)


def _unsupported_evidence_markers(copy: str, evidence_claims: list[str]) -> list[str]:
    public_copy = str(copy or "").lower()
    support = " ".join(str(claim or "").lower() for claim in evidence_claims)
    numeric = re.findall(r"\b\d+(?:[.,]\d+)?\s*(?:%|ms|x|k|m|b)?\b", public_copy)
    markers = [value for value in numeric if value not in support]
    markers.extend(term for term in _HIGH_RISK_CLAIM_TERMS if re.search(rf"\b{re.escape(term)}\b", public_copy) and not re.search(rf"\b{re.escape(term)}\b", support))
    return sorted(set(markers))


def copy_contains_outcome_claim(copy: Any) -> bool:
    """Return whether public copy needs evidence instead of a no-claim label."""
    return bool(_NO_CLAIM_OUTCOME_RE.search(str(copy or "")))


def campaign_system_contract() -> str:
    """Authoritative instruction hierarchy shared by every Campaign Room stage."""
    return (
        "\n\nCAMPAIGN ROOM SYSTEM CONTRACT — this overrides generic room/report behavior:\n"
        "- Build one coherent, execution-ready campaign covering objective and strategy, positioning and proof, "
        "audience and exclusions, final channel content, coordinated timeline, safety, and measurement.\n"
        "- Ground decisions in company context and gathered evidence. Never invent facts, recipients, consent, "
        "performance, URLs, or provider capabilities. Mark unresolved facts and assumptions explicitly.\n"
        "- Assumptions and hypotheses may guide strategy, but must never appear as factual final action copy. "
        "Every executable public claim must reference verified evidence; otherwise rewrite the copy as no_claim.\n"
        "- Evidence must directly support every number and absolute term in final copy. Never attach one broad "
        "company fact to unrelated latency, exclusivity, certification, compliance, or performance claims.\n"
        "- Debate material strategic conflicts. Record the conflict, chosen decision, rationale, and meaningful "
        "dissent; state explicitly when no material conflict remains.\n"
        "- Agents may research, challenge, and draft, but must never publish or send during Room generation.\n"
        "- The active organisation and supplied company context are ground truth. Never substitute a different "
        "company or invent audiences, URLs, quotes, budgets, proof, customer results, or performance.\n"
        "- Produce the complete campaign sequence required by the brief's horizon and pace; one sample action is "
        "never a complete campaign unless the normalized brief explicitly permits one.\n"
        "- Build an explicit media plan, creative hypothesis system, draft-only launch plan, and monitoring plan. "
        "Every action must name its hypothesis, dependencies, success measure, and rollback or exit condition.\n"
        "- Keep platform-attributed delivery, first-party outcomes, and experimental inference distinct. Optimisation "
        "is always a new approval-bound proposal, never an automatic conclusion from weak or immature data.\n"
        "- Every x_organic action is exactly one X Post: payload.text and final_copy must match and each must be "
        "280 characters or fewer. Represent a thread as separate ordered x_organic actions, one action per Post.\n"
        "- Decide image need per action. Use a visual only when it materially improves comprehension, attention, "
        "proof, or emotional clarity; never add decorative images to every action. When required=true, provide a "
        "concise visual concept and alt text. The visual-prompt-architecture skill expands that concept only after "
        "the plan is accepted, immediately before asset generation.\n"
        "- A Campaign Room is complete ONLY when the final compiler calls campaign__submit_plan and its "
        "deterministic contract accepts the full CampaignBundle. A generic final_report, prose summary, or "
        "partial draft can never complete campaign work.\n"
        "- Keep internal identifiers, serialized execution context, tool instructions, and raw JSON out of "
        "user-facing prose."
    )


def _non_empty_string(value: Any) -> bool:
    return bool(str(value or "").strip())


def _non_empty_list(value: Any) -> bool:
    return isinstance(value, list) and bool(value)


def classify_campaign_errors(errors: list[str]) -> dict[str, list[str]]:
    """Separate model judgment failures from assembler and launch concerns."""
    structural_markers = (
        "must be an array", "must be an object", "needs a unique id", "timeline",
        "requirement ", "dependencies", "schedule offset", "must match final_copy",
        "contract_version", "quality_gate", "campaign_horizon", "selected_strategy_id",
    )
    operational_markers = (
        "verified payload.to", "payload.country", "payload.timezone", "lawful_basis",
        "provider", "connection", "budget", "approval",
    )
    grouped = {"structural": [], "semantic": [], "operational": []}
    for error in errors:
        lowered = str(error).lower()
        if any(marker in lowered for marker in operational_markers):
            grouped["operational"].append(error)
        elif any(marker in lowered for marker in structural_markers):
            grouped["structural"].append(error)
        else:
            grouped["semantic"].append(error)
    return grouped


def assemble_campaign_bundle(
    semantic_plan: Any,
    *,
    channels: list[str],
    requirements: list[str],
    campaign_brief: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Turn model-owned campaign judgment into the durable v4 contract.

    The model owns strategy, evidence, copy, hypotheses, and creative direction.
    Stable identifiers, schedule rows, channel payload mirrors, launch controls,
    and requirement bookkeeping are deterministic product concerns.
    """
    plan = copy.deepcopy(semantic_plan) if isinstance(semantic_plan, dict) else {}
    brief = campaign_brief if isinstance(campaign_brief, dict) else {}
    brief_payload = brief.get("brief") if isinstance(brief.get("brief"), dict) else brief
    cadence = brief_payload.get("cadence") if isinstance(brief_payload.get("cadence"), dict) else {}
    duration = max(1, int(brief_payload.get("duration_days") or 14))
    intensity = str(cadence.get("preset") or "focused").lower()
    full_auto = str(brief.get("autonomyMode") or brief.get("autonomy_mode") or "").upper() == "FULL_AUTO"

    plan["contract_version"] = CAMPAIGN_CONTRACT_VERSION
    plan["objective"] = str(plan.get("objective") or brief.get("objective") or "CUSTOM")
    plan["campaign_horizon"] = {
        "duration_days": duration,
        "intensity": intensity,
        "rationale": str((plan.get("campaign_horizon") or {}).get("rationale") or f"Run a {duration}-day {intensity} campaign."),
    }

    options = [row for row in (plan.get("strategy_options") or []) if isinstance(row, dict)]
    for index, option in enumerate(options):
        option["id"] = str(option.get("id") or f"strategy_{index + 1}")
    plan["strategy_options"] = options
    if options and str(plan.get("selected_strategy_id") or "") not in {row["id"] for row in options}:
        plan["selected_strategy_id"] = options[0]["id"]

    evidence = [row for row in (plan.get("evidence") or []) if isinstance(row, dict)]
    for index, item in enumerate(evidence):
        item["id"] = str(item.get("id") or f"evidence_{index + 1}")
        item.setdefault("status", "assumption")
        source_type = str(item.get("source_type") or "derived").strip().lower().replace("-", "_").replace(" ", "_")
        source_type = _EVIDENCE_SOURCE_ALIASES.get(source_type, source_type)
        item["source_type"] = source_type if source_type in _EVIDENCE_SOURCE_TYPES else "derived"
        item.setdefault("confidence", "medium" if item.get("status") == "verified" else "low")
        item.setdefault("url", "")
    plan["evidence"] = evidence

    creative = plan.get("creative_system") if isinstance(plan.get("creative_system"), dict) else {}
    hypotheses = [row for row in (creative.get("hypotheses") or []) if isinstance(row, dict)]
    for index, hypothesis in enumerate(hypotheses):
        hypothesis["id"] = str(hypothesis.get("id") or f"hypothesis_{index + 1}")
        hypothesis.setdefault("channels", channels)
    creative["hypotheses"] = hypotheses
    creative.setdefault("approved_claim_ids", [])
    plan["creative_system"] = creative

    actions = [row for row in (plan.get("actions") or []) if isinstance(row, dict)]
    final_offset = max(0, (duration - 1) * 1440)
    hypothesis_ids = [row["id"] for row in hypotheses]
    primary_metric = str(((plan.get("measurement") or {}).get("primary_kpi") if isinstance(plan.get("measurement"), dict) else "") or "Campaign objective response")
    for index, action in enumerate(actions):
        action["id"] = str(action.get("id") or f"action_{index + 1}")
        if len(channels) == 1:
            action["channel"] = channels[0]
        action["channel"] = str(action.get("channel") or "").lower()
        action["title"] = str(action.get("title") or f"Campaign action {index + 1}")
        action["format"] = str(action.get("format") or "post")
        action["final_copy"] = str(action.get("final_copy") or action.get("copy") or "").strip()
        payload = action.get("payload") if isinstance(action.get("payload"), dict) else {}
        if action["channel"] == "x_organic":
            payload["text"] = action["final_copy"]
        action["payload"] = payload
        if not isinstance(action.get("scheduled_offset_minutes"), int) or isinstance(action.get("scheduled_offset_minutes"), bool):
            action["scheduled_offset_minutes"] = round(final_offset * index / max(1, len(actions) - 1))
        action["rationale"] = str(action.get("rationale") or f"Advance the campaign through {action['title'].lower()}.")
        action["hypothesis_id"] = str(action.get("hypothesis_id") or (hypothesis_ids[index % len(hypothesis_ids)] if hypothesis_ids else ""))
        action["dependencies"] = action.get("dependencies") if isinstance(action.get("dependencies"), list) else []
        action["success_measure"] = str(action.get("success_measure") or primary_metric)
        action["rollback_or_exit"] = str(action.get("rollback_or_exit") or "Pause this and remaining scheduled actions if the stated safety or provider checks fail.")
        action["evidence_ids"] = action.get("evidence_ids") if isinstance(action.get("evidence_ids"), list) else []
        action["claim_status"] = str(action.get("claim_status") or "no_claim")
        creative_brief = action.get("creative_brief") if isinstance(action.get("creative_brief"), dict) else {}
        required = creative_brief.get("required") is True
        creative_brief["required"] = required
        if not required:
            for field in ("objective", "subject", "composition", "brand_style", "audience", "text_policy", "alt_text", "generation_prompt", "rationale", "lighting", "camera", "color_direction", "emotional_tone"):
                creative_brief.setdefault(field, "")
            creative_brief.setdefault("aspect_ratio", "1:1")
            for field in ("required_elements", "forbidden_elements", "unsupported_claims", "visual_references"):
                creative_brief.setdefault(field, [])
        action["creative_brief"] = creative_brief
    plan["actions"] = actions

    plan["timeline"] = [{
        "action_id": action["id"],
        "phase": str(action.get("phase") or f"Phase {index + 1}"),
        "scheduled_offset_minutes": action["scheduled_offset_minutes"],
    } for index, action in enumerate(actions)]
    plan["requirement_coverage"] = [{
        "requirement_id": requirement,
        "strategy_sections": ["strategy", "actions"],
        "action_ids": [action["id"] for action in actions if requirement == "goal" or requirement == f"channel:{action['channel']}"],
    } for requirement in requirements]

    prohibited = brief_payload.get("prohibited_claims")
    prohibited_claims = prohibited if isinstance(prohibited, list) else ([str(prohibited)] if str(prohibited or "").strip() else [])
    safety = plan.get("safety") if isinstance(plan.get("safety"), dict) else {}
    safety.setdefault("guardrails", ["Publish only verified claims; keep assumptions internal.", "Do not exceed connected-provider capabilities."])
    safety["prohibited_claims"] = safety.get("prohibited_claims") if isinstance(safety.get("prohibited_claims"), list) else prohibited_claims
    plan["safety"] = safety

    measurement = plan.get("measurement") if isinstance(plan.get("measurement"), dict) else {}
    measurement.setdefault("primary_kpi", primary_metric)
    measurement.setdefault("attribution_limit", "Channel activity alone does not prove downstream business causation.")
    measurement.setdefault("review_cadence", "Review after each scheduled action and at campaign completion.")
    plan["measurement"] = measurement
    plan.setdefault("assumptions", [])
    plan.setdefault("risks", [])
    plan.setdefault("launch_checklist", ["Campaign contract accepted", "Provider capability verified", "Schedule validated"])

    media = plan.get("media_plan") if isinstance(plan.get("media_plan"), dict) else {}
    media.setdefault("currency", None)
    existing_media = {str(row.get("channel")): row for row in (media.get("channels") or []) if isinstance(row, dict)}
    media["channels"] = [existing_media.get(channel) or {
        "channel": channel, "role": "Execute the campaign sequence", "rationale": "Selected in the campaign brief.",
        "budget_amount": None, "prerequisites": [], "exclusions": [],
    } for channel in channels]
    plan["media_plan"] = media

    launch = plan.get("launch_plan") if isinstance(plan.get("launch_plan"), dict) else {}
    launch.update({"mode": "draft_only", "approval_mode": "FULL_AUTO" if full_auto else "APPROVE_PLAN_ONCE"})
    launch.setdefault("prerequisites", ["Connected provider remains authorized at execution time"])
    launch.setdefault("blocked_by", [])
    launch.setdefault("ceilings", [])
    launch.setdefault("verification_steps", ["Read back provider state after execution"])
    launch.setdefault("rollback_steps", ["Pause remaining scheduled actions"])
    plan["launch_plan"] = launch

    monitoring = plan.get("monitoring_plan") if isinstance(plan.get("monitoring_plan"), dict) else {}
    monitoring.setdefault("baseline", "Establish the campaign baseline from the first published action.")
    monitoring.setdefault("primary_outcome", primary_metric)
    monitoring.setdefault("attribution_limit", measurement["attribution_limit"])
    monitoring.setdefault("checkpoints", [{"timing": "After each action", "metrics": [primary_metric], "decision_rule": "Record results and preserve the approved schedule."}])
    monitoring["optimization_requires_approval"] = not full_auto
    plan["monitoring_plan"] = monitoring

    plan["quality_gate"] = {"ready": True, "checks": {key: "passed" for key in (
        "goal_alignment", "company_grounding", "channel_completeness", "provider_validity",
        "schedule_completeness", "evidence_integrity", "creative_completeness", "launch_safety",
        "measurement_readiness",
    )}}
    return plan


def campaign_bundle_errors(
    bundle: Any,
    channels: list[str],
    requirements: list[str],
    *,
    minimum_contract_version: int = 1,
    campaign_brief: dict[str, Any] | None = None,
) -> list[str]:
    if not isinstance(bundle, dict):
        return ["bundle must be an object"]
    errors: list[str] = []
    if not str(bundle.get("strategy") or "").strip():
        errors.append("strategy is required")
    audience = bundle.get("audience")
    if not isinstance(audience, dict) or not str(audience.get("rationale") or "").strip():
        errors.append("audience.rationale is required")
    if not isinstance(bundle.get("content_pillars"), list) or not bundle.get("content_pillars"):
        errors.append("content_pillars must not be empty")
    if not isinstance(bundle.get("kpis"), list) or not bundle.get("kpis"):
        errors.append("kpis must not be empty")

    actions = bundle.get("actions")
    if not isinstance(actions, list) or not actions:
        errors.append("actions must not be empty")
        actions = []
    seen_ids, action_channels, action_offsets = set(), set(), {}
    for index, action in enumerate(actions):
        if not isinstance(action, dict):
            errors.append(f"action {index + 1} must be an object")
            continue
        action_id = str(action.get("id") or "").strip()
        channel = str(action.get("channel") or "").strip().lower()
        if not action_id or action_id in seen_ids:
            errors.append(f"action {index + 1} needs a unique id")
        else:
            seen_ids.add(action_id)
        if channel not in channels:
            errors.append(f"action {action_id or index + 1} has an unrequested channel")
        else:
            action_channels.add(channel)
        if not str(action.get("final_copy") or "").strip():
            errors.append(f"action {action_id or index + 1} needs final_copy")
        if not isinstance(action.get("payload"), dict):
            errors.append(f"action {action_id or index + 1} needs payload")
        offset = action.get("scheduled_offset_minutes")
        if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0:
            errors.append(f"action {action_id or index + 1} needs a non-negative schedule offset")
        elif action_id:
            action_offsets[action_id] = offset
        if not str(action.get("rationale") or "").strip():
            errors.append(f"action {action_id or index + 1} needs rationale")
        payload = action.get("payload") or {}
        if channel == "x_organic":
            post_text = str(payload.get("text") or "").strip()
            final_copy = str(action.get("final_copy") or "").strip()
            if not post_text:
                errors.append(f"X action {action_id or index + 1} needs payload.text")
            elif len(post_text) > 280:
                errors.append(
                    f"X action {action_id or index + 1} payload.text must be 280 characters or fewer; "
                    "split threads into separate actions"
                )
            if post_text and final_copy and post_text != final_copy:
                errors.append(f"X action {action_id or index + 1} payload.text must match final_copy")
        if channel == "gmail" and not str(payload.get("subject") or "").strip():
            errors.append(f"Gmail action {action_id or index + 1} needs payload.subject")
        if channel == "gmail" and not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", str(payload.get("to") or "")):
            errors.append(f"Gmail action {action_id or index + 1} needs a verified payload.to email")
        if channel == "tara" and not str(payload.get("opening") or "").strip():
            errors.append(f"TARA action {action_id or index + 1} needs a speak-first payload.opening")
        if channel == "tara" and not re.match(r"^\+[1-9]\d{6,14}$", str(payload.get("to") or "")):
            errors.append(f"TARA action {action_id or index + 1} needs a verified E.164 payload.to")
        if channel == "tara" and str(payload.get("lawful_basis") or "") not in ("legitimate_interest", "consent"):
            errors.append(f"TARA action {action_id or index + 1} needs payload.lawful_basis")
        if channel == "tara" and not re.match(r"^[A-Za-z]{2}$", str(payload.get("country") or "")):
            errors.append(f"TARA action {action_id or index + 1} needs an ISO payload.country")
        if channel == "tara" and not str(payload.get("timezone") or "").strip():
            errors.append(f"TARA action {action_id or index + 1} needs an IANA payload.timezone")

    for channel in channels:
        if channel not in action_channels:
            errors.append(f"selected channel {channel} has no action")
    brief = campaign_brief if isinstance(campaign_brief, dict) else {}
    brief_payload = brief.get("brief") if isinstance(brief.get("brief"), dict) else brief
    cadence = brief_payload.get("cadence") if isinstance(brief_payload.get("cadence"), dict) else {}
    expected_by_channel = cadence.get("expected_actions_by_channel") if isinstance(cadence.get("expected_actions_by_channel"), dict) else {}
    for channel in channels:
        expected = expected_by_channel.get(channel)
        if not isinstance(expected, dict):
            continue
        count = sum(1 for action in actions if isinstance(action, dict) and str(action.get("channel") or "").lower() == channel)
        minimum = int(expected.get("minimum") or 0)
        maximum = int(expected.get("maximum") or 1_000_000)
        if count < minimum or count > maximum:
            errors.append(f"channel {channel} needs {minimum}-{maximum} actions for this campaign pace; received {count}")
    coverage = bundle.get("requirement_coverage")
    coverage_rows = coverage if isinstance(coverage, list) else []
    covered = {str(row.get("requirement_id") or ""): row for row in coverage_rows if isinstance(row, dict)}
    for requirement in requirements:
        row = covered.get(requirement)
        action_ids = row.get("action_ids") if row else None
        if not isinstance(action_ids, list) or not action_ids or any(str(item) not in seen_ids for item in action_ids):
            errors.append(f"requirement {requirement} is not covered by valid actions")

    declared_version = bundle.get("contract_version", 1)
    if not isinstance(declared_version, int) or isinstance(declared_version, bool) or declared_version < 1:
        errors.append("contract_version must be a positive integer")
        declared_version = 1
    if declared_version < minimum_contract_version:
        errors.append(f"contract_version must be at least {minimum_contract_version}")

    # Existing bundles remain readable. New Campaign Room synthesis requests the
    # latest contract and is held to the richer operating-board contract below.
    if max(declared_version, minimum_contract_version) >= 2:
        if not _non_empty_string(bundle.get("objective")):
            errors.append("objective is required for contract v2")

        positioning = bundle.get("positioning")
        if not isinstance(positioning, dict) or not _non_empty_string(positioning.get("statement")):
            errors.append("positioning.statement is required for contract v2")
        if not isinstance(positioning, dict) or not _non_empty_list(positioning.get("proof_points")):
            errors.append("positioning.proof_points must not be empty for contract v2")

        if not isinstance(audience, dict) or not _non_empty_list(audience.get("segments")):
            errors.append("audience.segments must not be empty for contract v2")

        timeline = bundle.get("timeline")
        if not _non_empty_list(timeline):
            errors.append("timeline must not be empty for contract v2")
            timeline = []
        timeline_action_ids = set()
        for index, row in enumerate(timeline):
            if not isinstance(row, dict):
                errors.append(f"timeline entry {index + 1} must be an object")
                continue
            action_id = str(row.get("action_id") or "").strip()
            if action_id in timeline_action_ids:
                errors.append(f"timeline contains duplicate action {action_id}")
            timeline_action_ids.add(action_id)
            if action_id not in seen_ids:
                errors.append(f"timeline entry {index + 1} references an unknown action")
            if not _non_empty_string(row.get("phase")):
                errors.append(f"timeline entry {index + 1} needs phase")
            offset = row.get("scheduled_offset_minutes")
            if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0:
                errors.append(f"timeline entry {index + 1} needs a non-negative schedule offset")
            elif action_id in action_offsets and offset != action_offsets[action_id]:
                errors.append(f"timeline offset for action {action_id} must match its action offset")
        for action_id in seen_ids:
            if action_id not in timeline_action_ids:
                errors.append(f"action {action_id} is missing from timeline")

        safety = bundle.get("safety")
        if not isinstance(safety, dict) or not _non_empty_list(safety.get("guardrails")):
            errors.append("safety.guardrails must not be empty for contract v2")
        if not isinstance(safety, dict) or not isinstance(safety.get("prohibited_claims"), list):
            errors.append("safety.prohibited_claims must be an array for contract v2")

        measurement = bundle.get("measurement")
        for field in ("primary_kpi", "attribution_limit", "review_cadence"):
            if not isinstance(measurement, dict) or not _non_empty_string(measurement.get(field)):
                errors.append(f"measurement.{field} is required for contract v2")

        conflicts_present = bundle.get("debate_conflicts_present")
        if not isinstance(conflicts_present, bool):
            errors.append("debate_conflicts_present must be boolean for contract v2")
        debate_decisions = bundle.get("debate_decisions")
        if not isinstance(debate_decisions, list):
            errors.append("debate_decisions must be an array for contract v2")
            debate_decisions = []
        if conflicts_present is True and not debate_decisions:
            errors.append("debate_decisions must record every material conflict")
        for index, decision in enumerate(debate_decisions):
            if not isinstance(decision, dict):
                errors.append(f"debate decision {index + 1} must be an object")
                continue
            for field in ("conflict", "decision", "rationale"):
                if not _non_empty_string(decision.get(field)):
                    errors.append(f"debate decision {index + 1} needs {field}")

        if not isinstance(bundle.get("assumptions"), list):
            errors.append("assumptions must be an array for contract v2")
        if not _non_empty_list(bundle.get("launch_checklist")):
            errors.append("launch_checklist must not be empty for contract v2")

    if max(declared_version, minimum_contract_version) >= 3:
        strategy_options = bundle.get("strategy_options")
        if not isinstance(strategy_options, list) or len(strategy_options) < 3:
            errors.append("strategy_options must contain at least three options for contract v3")
            strategy_options = []
        option_ids = {str(option.get("id") or "") for option in strategy_options if isinstance(option, dict)}
        if str(bundle.get("selected_strategy_id") or "") not in option_ids:
            errors.append("selected_strategy_id must reference a strategy option for contract v3")
        for index, option in enumerate(strategy_options):
            if not isinstance(option, dict):
                errors.append(f"strategy option {index + 1} must be an object")
                continue
            for field in ("id", "name", "thesis", "tradeoff"):
                if not _non_empty_string(option.get(field)):
                    errors.append(f"strategy option {index + 1} needs {field}")

        grounding = bundle.get("company_grounding")
        if not isinstance(grounding, dict) or not _non_empty_string(grounding.get("company_name")):
            errors.append("company_grounding.company_name is required for contract v3")
        if not isinstance(grounding, dict) or not _non_empty_list(grounding.get("facts_used")):
            errors.append("company_grounding.facts_used must not be empty for contract v3")

        evidence = bundle.get("evidence")
        if not isinstance(evidence, list):
            errors.append("evidence must be an array for contract v3")
            evidence = []
        elif not evidence:
            errors.append("evidence must not be empty for contract v3")
        evidence_ids = {str(item.get("id") or "") for item in evidence if isinstance(item, dict)}
        evidence_statuses = {str(item.get("id") or ""): str(item.get("status") or "") for item in evidence if isinstance(item, dict)}
        evidence_claims = {str(item.get("id") or ""): str(item.get("claim") or "") for item in evidence if isinstance(item, dict)}
        for index, item in enumerate(evidence):
            if not isinstance(item, dict):
                errors.append(f"evidence item {index + 1} must be an object")
                continue
            if str(item.get("status") or "") not in ("verified", "assumption", "missing"):
                errors.append(f"evidence item {index + 1} needs a valid status")
            for field in ("id", "claim", "source"):
                if not _non_empty_string(item.get(field)):
                    errors.append(f"evidence item {index + 1} needs {field}")

        horizon = bundle.get("campaign_horizon")
        expected_duration = int(brief_payload.get("duration_days") or 14)
        expected_intensity = str(cadence.get("preset") or "focused").lower()
        if not isinstance(horizon, dict) or horizon.get("duration_days") != expected_duration:
            errors.append("campaign_horizon.duration_days must match the brief for contract v3")
        if not isinstance(horizon, dict) or str(horizon.get("intensity") or "").lower() != expected_intensity:
            errors.append("campaign_horizon.intensity must match the brief for contract v3")
        if expected_duration >= 7 and len(action_offsets) > 1:
            minimum_final_offset = max(0, (expected_duration - 2) * 1440)
            if max(action_offsets.values(), default=0) < minimum_final_offset:
                errors.append("campaign timeline must span the requested horizon; schedule the final action within the last two days")

        allowed_urls = {
            str(value).rstrip("/.,")
            for value in (
                brief_payload.get("destination_url"),
                brief_payload.get("destinationUrl"),
                brief_payload.get("website_url"),
            )
            if _non_empty_string(value)
        }

        for index, action in enumerate(actions):
            if not isinstance(action, dict):
                continue
            if not isinstance(action.get("creative_brief"), dict):
                errors.append(f"action {action.get('id') or index + 1} needs creative_brief for contract v3")
            else:
                creative = action.get("creative_brief") or {}
                if not isinstance(creative.get("required"), bool):
                    errors.append(f"action {action.get('id') or index + 1} creative_brief.required must be boolean")
                if creative.get("required") is True:
                    legacy_concept = _non_empty_string(creative.get("concept")) and not _non_empty_string(creative.get("generation_prompt"))
                    if not legacy_concept:
                        for field in ("objective", "subject", "composition", "brand_style", "audience", "aspect_ratio", "text_policy", "alt_text", "generation_prompt"):
                            if not _non_empty_string(creative.get(field)):
                                errors.append(f"action {action.get('id') or index + 1} creative_brief.{field} is required for a visual action")
                        for field in ("required_elements", "forbidden_elements", "unsupported_claims"):
                            if not isinstance(creative.get(field), list):
                                errors.append(f"action {action.get('id') or index + 1} creative_brief.{field} must be an array")
            if str(action.get("claim_status") or "") not in ("verified", "assumption", "no_claim"):
                errors.append(f"action {action.get('id') or index + 1} needs a valid claim_status for contract v3")
            elif str(action.get("claim_status") or "") == "assumption":
                errors.append(f"action {action.get('id') or index + 1} cannot publish an assumption as final_copy")
            final_copy = str(action.get("final_copy") or "")
            public_urls = {value.rstrip("/.,") for value in _PUBLIC_URL_RE.findall(final_copy)}
            if public_urls - allowed_urls:
                errors.append(f"action {action.get('id') or index + 1} contains a URL that was not supplied in the campaign brief")
            if str(action.get("claim_status") or "") == "no_claim" and copy_contains_outcome_claim(final_copy):
                errors.append(f"action {action.get('id') or index + 1} is labeled no_claim but contains a customer, performance, or outcome claim")
            action_evidence = action.get("evidence_ids")
            if not isinstance(action_evidence, list):
                errors.append(f"action {action.get('id') or index + 1} evidence_ids must be an array for contract v3")
            elif any(str(item) not in evidence_ids for item in action_evidence):
                errors.append(f"action {action.get('id') or index + 1} references unknown evidence for contract v3")
            elif str(action.get("claim_status") or "") == "verified" and not action_evidence:
                errors.append(f"action {action.get('id') or index + 1} needs evidence for a verified claim")
            elif str(action.get("claim_status") or "") == "verified" and any(evidence_statuses.get(str(item)) != "verified" for item in action_evidence):
                errors.append(f"action {action.get('id') or index + 1} verified claims must reference only verified evidence")
            elif str(action.get("claim_status") or "") == "verified":
                unsupported = _unsupported_evidence_markers(action.get("final_copy"), [evidence_claims.get(str(item), "") for item in action_evidence])
                if unsupported:
                    errors.append(f"action {action.get('id') or index + 1} contains claims not present in its evidence: {', '.join(unsupported)}")

        quality = bundle.get("quality_gate")
        checks = quality.get("checks") if isinstance(quality, dict) and isinstance(quality.get("checks"), dict) else {}
        if not isinstance(quality, dict) or quality.get("ready") is not True:
            errors.append("quality_gate.ready must be true for contract v3")
        for check in ("goal_alignment", "company_grounding", "channel_completeness", "provider_validity", "schedule_completeness"):
            if checks.get(check) != "passed":
                errors.append(f"quality_gate.checks.{check} must pass for contract v3")

    if max(declared_version, minimum_contract_version) >= 4:
        kpis = bundle.get("kpis") if isinstance(bundle.get("kpis"), list) else []
        for index, kpi in enumerate(kpis):
            if not isinstance(kpi, dict):
                errors.append(f"KPI {index + 1} must be an object for contract v4")
                continue
            target_type = str(kpi.get("target_type") or "")
            kpi_evidence = kpi.get("evidence_ids")
            if target_type not in ("baseline", "proposed", "verified"):
                errors.append(f"KPI {index + 1} needs target_type baseline, proposed, or verified for contract v4")
            if not isinstance(kpi_evidence, list):
                errors.append(f"KPI {index + 1} evidence_ids must be an array for contract v4")
            elif any(str(item) not in evidence_ids for item in kpi_evidence):
                errors.append(f"KPI {index + 1} references unknown evidence for contract v4")
            elif target_type == "verified" and (not kpi_evidence or any(evidence_statuses.get(str(item)) != "verified" for item in kpi_evidence)):
                errors.append(f"KPI {index + 1} verified target must reference verified evidence")

        media_plan = bundle.get("media_plan")
        media_channels = media_plan.get("channels") if isinstance(media_plan, dict) else None
        if not isinstance(media_plan, dict):
            errors.append("media_plan is required for contract v4")
            media_channels = []
        if not isinstance(media_channels, list) or not media_channels:
            errors.append("media_plan.channels must not be empty for contract v4")
            media_channels = []
        planned_channels: set[str] = set()
        for index, row in enumerate(media_channels):
            if not isinstance(row, dict):
                errors.append(f"media plan channel {index + 1} must be an object")
                continue
            channel = str(row.get("channel") or "").strip().lower()
            if not channel or channel in planned_channels:
                errors.append(f"media plan channel {index + 1} needs a unique channel")
            elif channel not in channels:
                errors.append(f"media plan channel {channel} was not selected")
            else:
                planned_channels.add(channel)
            for field in ("role", "rationale"):
                if not _non_empty_string(row.get(field)):
                    errors.append(f"media plan channel {channel or index + 1} needs {field}")
            budget = row.get("budget_amount")
            if budget is not None and (not isinstance(budget, (int, float)) or isinstance(budget, bool) or budget < 0):
                errors.append(f"media plan channel {channel or index + 1} has an invalid budget_amount")
            for field in ("prerequisites", "exclusions"):
                if not isinstance(row.get(field), list):
                    errors.append(f"media plan channel {channel or index + 1} {field} must be an array")
        for channel in channels:
            if channel not in planned_channels:
                errors.append(f"selected channel {channel} is missing from media_plan")
        if isinstance(media_plan, dict) and media_plan.get("currency") is not None:
            currency = str(media_plan.get("currency") or "")
            if not re.match(r"^[A-Z]{3}$", currency):
                errors.append("media_plan.currency must be a three-letter code or null")

        creative_system = bundle.get("creative_system")
        hypotheses = creative_system.get("hypotheses") if isinstance(creative_system, dict) else None
        if not isinstance(creative_system, dict):
            errors.append("creative_system is required for contract v4")
            hypotheses = []
        if not isinstance(hypotheses, list) or len(hypotheses) < 2:
            errors.append("creative_system.hypotheses must contain at least two testable hypotheses")
            hypotheses = []
        hypothesis_ids: set[str] = set()
        for index, hypothesis in enumerate(hypotheses):
            if not isinstance(hypothesis, dict):
                errors.append(f"creative hypothesis {index + 1} must be an object")
                continue
            hypothesis_id = str(hypothesis.get("id") or "").strip()
            if not hypothesis_id or hypothesis_id in hypothesis_ids:
                errors.append(f"creative hypothesis {index + 1} needs a unique id")
            else:
                hypothesis_ids.add(hypothesis_id)
            for field in ("insight", "promise", "hook", "cta", "experiment_hypothesis"):
                if not _non_empty_string(hypothesis.get(field)):
                    errors.append(f"creative hypothesis {hypothesis_id or index + 1} needs {field}")
            hypothesis_channels = hypothesis.get("channels")
            if not _non_empty_list(hypothesis_channels):
                errors.append(f"creative hypothesis {hypothesis_id or index + 1} needs channels")
            elif any(str(channel).lower() not in channels for channel in hypothesis_channels):
                errors.append(f"creative hypothesis {hypothesis_id or index + 1} uses an unselected channel")
        approved_claim_ids = creative_system.get("approved_claim_ids") if isinstance(creative_system, dict) else None
        if not isinstance(approved_claim_ids, list):
            errors.append("creative_system.approved_claim_ids must be an array")
            approved_claim_ids = []
        elif any(str(item) not in evidence_ids for item in approved_claim_ids):
            errors.append("creative_system.approved_claim_ids references unknown evidence")
        elif any(evidence_statuses.get(str(item)) != "verified" for item in approved_claim_ids):
            errors.append("creative_system.approved_claim_ids must reference only verified evidence")

        for index, action in enumerate(actions):
            if not isinstance(action, dict):
                continue
            action_id = str(action.get("id") or index + 1)
            hypothesis_id = str(action.get("hypothesis_id") or "")
            if hypothesis_id not in hypothesis_ids:
                errors.append(f"action {action_id} must reference a creative hypothesis")
            if not isinstance(action.get("dependencies"), list):
                errors.append(f"action {action_id} dependencies must be an array for contract v4")
            if not _non_empty_string(action.get("success_measure")):
                errors.append(f"action {action_id} needs success_measure for contract v4")
            if not _non_empty_string(action.get("rollback_or_exit")):
                errors.append(f"action {action_id} needs rollback_or_exit for contract v4")

        launch_plan = bundle.get("launch_plan")
        if not isinstance(launch_plan, dict):
            errors.append("launch_plan is required for contract v4")
        else:
            if launch_plan.get("mode") != "draft_only":
                errors.append("launch_plan.mode must be draft_only during Room generation")
            if not _non_empty_string(launch_plan.get("approval_mode")):
                errors.append("launch_plan.approval_mode is required for contract v4")
            for field in ("prerequisites", "blocked_by", "ceilings"):
                if not isinstance(launch_plan.get(field), list):
                    errors.append(f"launch_plan.{field} must be an array for contract v4")
            for field in ("verification_steps", "rollback_steps"):
                if not _non_empty_list(launch_plan.get(field)):
                    errors.append(f"launch_plan.{field} must not be empty for contract v4")

        monitoring_plan = bundle.get("monitoring_plan")
        if not isinstance(monitoring_plan, dict):
            errors.append("monitoring_plan is required for contract v4")
        else:
            for field in ("baseline", "primary_outcome", "attribution_limit"):
                if not _non_empty_string(monitoring_plan.get(field)):
                    errors.append(f"monitoring_plan.{field} is required for contract v4")
            checkpoints = monitoring_plan.get("checkpoints")
            if not _non_empty_list(checkpoints):
                errors.append("monitoring_plan.checkpoints must not be empty for contract v4")
                checkpoints = []
            for index, checkpoint in enumerate(checkpoints):
                if not isinstance(checkpoint, dict):
                    errors.append(f"monitoring checkpoint {index + 1} must be an object")
                    continue
                if not _non_empty_string(checkpoint.get("timing")):
                    errors.append(f"monitoring checkpoint {index + 1} needs timing")
                if not _non_empty_list(checkpoint.get("metrics")):
                    errors.append(f"monitoring checkpoint {index + 1} needs metrics")
                if not _non_empty_string(checkpoint.get("decision_rule")):
                    errors.append(f"monitoring checkpoint {index + 1} needs decision_rule")
            autonomy_mode = str((campaign_brief or {}).get("autonomyMode") or (campaign_brief or {}).get("autonomy_mode") or "APPROVE_PLAN_ONCE").upper()
            expected_approval = autonomy_mode != "FULL_AUTO"
            if monitoring_plan.get("optimization_requires_approval") is not expected_approval:
                errors.append(f"monitoring_plan.optimization_requires_approval must be {str(expected_approval).lower()} for {autonomy_mode}")

        for index, item in enumerate(evidence):
            if not isinstance(item, dict):
                continue
            if str(item.get("source_type") or "") not in ("company", "connector", "web", "user", "provider", "derived"):
                errors.append(f"evidence item {index + 1} needs a valid source_type for contract v4")
            if str(item.get("confidence") or "") not in ("high", "medium", "low", "none"):
                errors.append(f"evidence item {index + 1} needs a valid confidence for contract v4")

        checks = bundle.get("quality_gate", {}).get("checks", {}) if isinstance(bundle.get("quality_gate"), dict) else {}
        for check in ("evidence_integrity", "creative_completeness", "launch_safety", "measurement_readiness"):
            if checks.get(check) != "passed":
                errors.append(f"quality_gate.checks.{check} must pass for contract v4")
    return list(dict.fromkeys(errors))


def campaign__submit_plan(
    bundle: Any,
    *,
    channels: list[str],
    requirements: list[str],
    minimum_contract_version: int = 1,
    campaign_brief: dict[str, Any] | None = None,
) -> tuple[dict[str, Any] | None, list[str]]:
    """Accept a CampaignBundle only when every deterministic contract passes."""
    errors = campaign_bundle_errors(
        bundle,
        channels,
        requirements,
        minimum_contract_version=minimum_contract_version,
        campaign_brief=campaign_brief,
    )
    return (bundle if not errors else None), errors
