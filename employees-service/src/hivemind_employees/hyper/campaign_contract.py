"""Deterministic completion contract for Campaign Rooms."""

import re
from typing import Any

CAMPAIGN_CONTRACT_VERSION = 2


def campaign_system_contract() -> str:
    """Authoritative instruction hierarchy shared by every Campaign Room stage."""
    return (
        "\n\nCAMPAIGN ROOM SYSTEM CONTRACT — this overrides generic room/report behavior:\n"
        "- Build one coherent, execution-ready campaign covering objective and strategy, positioning and proof, "
        "audience and exclusions, final channel content, coordinated timeline, safety, and measurement.\n"
        "- Ground decisions in company context and gathered evidence. Never invent facts, recipients, consent, "
        "performance, URLs, or provider capabilities. Mark unresolved facts and assumptions explicitly.\n"
        "- Debate material strategic conflicts. Record the conflict, chosen decision, rationale, and meaningful "
        "dissent; state explicitly when no material conflict remains.\n"
        "- Agents may research, challenge, and draft, but must never publish or send during Room generation.\n"
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


def campaign_bundle_errors(
    bundle: Any,
    channels: list[str],
    requirements: list[str],
    *,
    minimum_contract_version: int = 1,
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

    # Existing V1 bundles remain valid. New Campaign Room synthesis requests V2
    # and is held to the richer operating-report contract below.
    if max(declared_version, minimum_contract_version) >= CAMPAIGN_CONTRACT_VERSION:
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
    return list(dict.fromkeys(errors))


def campaign__submit_plan(
    bundle: Any,
    *,
    channels: list[str],
    requirements: list[str],
    minimum_contract_version: int = 1,
) -> tuple[dict[str, Any] | None, list[str]]:
    """Accept a CampaignBundle only when every deterministic contract passes."""
    errors = campaign_bundle_errors(
        bundle,
        channels,
        requirements,
        minimum_contract_version=minimum_contract_version,
    )
    return (bundle if not errors else None), errors
