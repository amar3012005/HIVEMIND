"""Output contract for every HyperAgent room, independent of specialist profile.

A Work Room may also have an execution_profile. A branding/research/runtime
room must still get a persisted output contract so the planner cannot default
to profile=none + invented visual artifacts.
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

EVIDENCE_HINTS = (
    "competitor", "competitors", "regulation", "regulatory", "gdpr", "compliance",
    "evidence", "source", "sources", "verify", "verified", "benchmark", "market",
    "residency", "iso", "audit", "claim", "claims", "test against",
)

EXPLICIT_VISUAL = re.compile(
    r"\b(?:visual\s+guide|lookbook|dashboard|mock(?:up)?s?|pitch\s+deck|slide\s*deck|"
    r"slides?|presentation|poster|banner|interactive\s+(?:doc|document|page)|"
    r"generate\s+(?:an?\s+)?image|deck|documents?)\b",
    re.I,
)

EXPLICIT_IMAGE_GENERATION = re.compile(
    r"(?:\b(?:generate|create|make|produce|render|design)\b.{0,100}"
    r"\b(?:image|images|visual|visuals|graphic|graphics|artwork|creative|logo|logos|brand\s+marks?|emblems?)\b|"
    r"\b(?:image|images|visual|visuals|graphic|graphics|artwork|creative)\b.{0,100}"
    r"\b(?:generate|create|make|produce|render|design)\b|"
    r"\b(?:i\s+(?:want|need)|we\s+(?:want|need)|give\s+me)\b.{0,60}"
    r"\b(?:an?\s+)?(?:image|visual|graphic|artwork|creative|logo|brand\s+mark|emblem)\b|"
    r"\b(?:final\s+(?:image|visual|graphic|artwork)|visual\s+artifact|"
    r"(?:image|visual|graphic|creative|logo)\s+(?:set|series))\b)",
    re.I | re.S,
)

EXPLICIT_FILE = re.compile(
    r"\b(?:spreadsheet|workbook|\.csv\b|xlsx|word\s+document|google\s+doc)\b",
    re.I,
)

RENDER_GAP_FRAGMENTS = (
    "production rendering checks",
    "requested interactive artifact",
    "interactive artifact did not pass",
)


def evidence_required_from_text(user_message: str) -> bool:
    text = (user_message or "").casefold()
    return any(hint in text for hint in EVIDENCE_HINTS)


def explicit_visual_request(user_message: str) -> bool:
    return bool(EXPLICIT_VISUAL.search(user_message or ""))


def explicit_image_generation_request(user_message: str) -> bool:
    """Return true only for an explicit request to produce raster visual work."""
    # A visual *guide* is an interactive/document deliverable, not a request to
    # synthesize image pixels. Keep that established render path distinct from
    # direct image/visual generation.
    if re.search(r"\bvisual\s+guide\b", user_message or "", re.I):
        return False
    return bool(EXPLICIT_IMAGE_GENERATION.search(user_message or ""))


def explicit_file_request(user_message: str) -> bool:
    return bool(EXPLICIT_FILE.search(user_message or ""))


def resolve_output_contract(
    *,
    user_message: str = "",
    room_kind: str = "",
    room_mode: str = "",
    execution_profile: Optional[Mapping[str, Any]] = None,
) -> Dict[str, Any]:
    profile = dict(execution_profile or {})
    allowed_outputs = {
        str(item).strip().lower()
        for item in (profile.get("allowed_outputs") or [])
        if str(item).strip()
    }
    profile_requires_visual = bool(
        profile.get("visual_artifact_required") is True
        or (allowed_outputs == {"artifact"} and profile.get("required_artifacts"))
    )
    generated_image = explicit_image_generation_request(user_message)
    visual = bool(profile_requires_visual or generated_image or explicit_visual_request(user_message))
    file_req = explicit_file_request(user_message)
    evidence = bool(profile.get("evidence_required")) or evidence_required_from_text(user_message)
    if visual:
        intended = "artifact"
        artifact_kind = "generated_image" if generated_image else "interactive_document"
    elif file_req:
        intended = "document"
        artifact_kind = None
    else:
        intended = "answer"
        artifact_kind = None
    return {
        "profile_id": profile.get("profile_id") or None,
        "room_kind": (room_kind or "").strip().lower() or None,
        "room_mode": (room_mode or "").strip().lower() or "runtime",
        "intended_output": intended,
        "intendedOutput": intended,
        "artifact_required": visual,
        "artifactRequired": visual,
        "artifact_kind": artifact_kind,
        "visual_enabled": visual,
        "evidence_required": evidence,
        "outreach_required": False,
    }


def artifact_intent_allowed(contract: Mapping[str, Any], planner_intent: Any) -> bool:
    if not contract.get("artifact_required"):
        return False
    return isinstance(planner_intent, dict)


def should_run_render_gate(contract: Mapping[str, Any]) -> bool:
    intended = str(contract.get("intendedOutput") or contract.get("intended_output") or "answer").lower()
    artifact_kind = str(contract.get("artifact_kind") or "").strip().lower()
    return (
        intended == "artifact"
        and artifact_kind != "generated_image"
        and bool(contract.get("artifactRequired") or contract.get("artifact_required"))
    )


def is_deferred_generated_image(contract: Mapping[str, Any]) -> bool:
    """Generated images are queued only after synthesis and governance."""
    return (
        str(contract.get("artifact_kind") or "").strip().lower() == "generated_image"
        and bool(contract.get("artifactRequired") or contract.get("artifact_required"))
    )


def is_render_gap(gap: str) -> bool:
    text = str(gap or "").casefold()
    return any(fragment in text for fragment in RENDER_GAP_FRAGMENTS)


def split_goalkeeper_gaps(
    gaps: Optional[Sequence[Any]],
    contract: Mapping[str, Any],
) -> Tuple[List[str], List[str]]:
    """Return (kept_gaps, dropped_render_gaps).

    Accidental visual intents must not keep a text room in the render-failure loop.
    """
    kept: List[str] = []
    dropped: List[str] = []
    run_render = should_run_render_gate(contract)
    for raw in gaps or []:
        gap = str(raw)
        if not run_render and is_render_gap(gap):
            dropped.append(gap)
        else:
            kept.append(gap)
    return kept, dropped


def labeled_unverified_draft(text: str, gaps: list) -> str:
    body = (text or "").strip()
    gap_lines = "\n".join(f"- {g}" for g in list(gaps or [])[:8] if str(g).strip())
    prefix = (
        "Draft. Unverified claims were removed or marked. "
        "This is not withheld for lack of context.\n"
    )
    if gap_lines:
        prefix += "Evidence gaps:\n" + gap_lines + "\n\n"
    return prefix + body
