"""Output contract for every HyperAgent room, independent of specialist profile.

A Work Room may also have an execution_profile. A branding/research/runtime
room must still get a persisted output contract so the planner cannot default
to profile=none + invented visual artifacts.
"""
from __future__ import annotations

import re
from typing import Any, Dict, Mapping, Optional

EVIDENCE_HINTS = (
    "competitor", "competitors", "regulation", "regulatory", "gdpr", "compliance",
    "evidence", "source", "sources", "verify", "verified", "benchmark", "market",
    "residency", "iso", "audit", "claim", "claims", "test against",
)

EXPLICIT_VISUAL = re.compile(
    r"\b(?:visual\s+guide|lookbook|dashboard|mock(?:up)?s?|pitch\s+deck|slide\s*deck|"
    r"slides?|presentation|poster|banner|interactive\s+(?:doc|document|page)|"
    r"generate\s+(?:an?\s+)?image)\b",
    re.I,
)

EXPLICIT_FILE = re.compile(
    r"\b(?:spreadsheet|workbook|\.csv\b|xlsx|word\s+document|google\s+doc)\b",
    re.I,
)


def evidence_required_from_text(user_message: str) -> bool:
    text = (user_message or "").casefold()
    return any(hint in text for hint in EVIDENCE_HINTS)


def explicit_visual_request(user_message: str) -> bool:
    return bool(EXPLICIT_VISUAL.search(user_message or ""))


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
    profile_requires_visual = profile.get("visual_artifact_required") is True
    visual = bool(profile_requires_visual or explicit_visual_request(user_message))
    file_req = explicit_file_request(user_message)
    evidence = bool(profile.get("evidence_required")) or evidence_required_from_text(user_message)
    if visual:
        intended = "artifact"
        artifact_kind = "interactive_document"
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
    return intended == "artifact" and bool(contract.get("artifactRequired") or contract.get("artifact_required"))


def labeled_unverified_draft(text: str, gaps: list) -> str:
    body = (text or "").strip()
    gap_lines = "\n".join(f"- {g}" for g in gaps if str(g).strip())
    prefix = (
        "Draft. Unverified claims were removed or marked. "
        "This is not withheld for lack of context.\n"
    )
    if gap_lines:
        prefix += "Evidence gaps:\n" + gap_lines + "\n\n"
    return prefix + body
