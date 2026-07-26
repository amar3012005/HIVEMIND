"""Deterministic completion contract for Campaign Rooms."""

import re
from typing import Any, Dict, List, Tuple


def campaign_bundle_errors(bundle: Any, channels: List[str], requirements: List[str]) -> List[str]:
    if not isinstance(bundle, dict):
        return ["bundle must be an object"]
    errors: List[str] = []
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
    seen_ids, action_channels = set(), set()
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
    return list(dict.fromkeys(errors))


def campaign__submit_plan(
    bundle: Any,
    *,
    channels: List[str],
    requirements: List[str],
) -> Tuple[Dict[str, Any] | None, List[str]]:
    """Accept a CampaignBundle only when every deterministic contract passes."""
    errors = campaign_bundle_errors(bundle, channels, requirements)
    return (bundle if not errors else None), errors
