"""Room-kind registry — one source of truth for how each kind of room behaves.

Formalizes the kind taxonomy that was scattered across skills/engine. The load-
bearing field is `lead_shape`:

  - "maker"  → produce/deliverable rooms (outreach, content, research). ONE writer
               leads and produces; at most ONE reviewer challenges. No skeptic
               tribunal — that was the sales-sheet failure (3 skeptics arguing
               "get a DPIA" instead of writing the sheet).
  - "panel"  → decision/strategy rooms. The full skeptic debate IS the value:
               surface disagreement, stress-test the call.
  - "auto"   → general rooms keep the existing balanced debate.

A produce intended_output (doc/sheet/email) forces "maker" regardless of kind —
you never want a skeptic panel blocking a deliverable.
"""
from __future__ import annotations

from typing import Dict, List, Any

# BE classifier kinds (hyper/skills) → vertical + lead shape.
KIND_REGISTRY: Dict[str, Dict[str, Any]] = {
    "outreach": {"vertical": "outreach", "lead_shape": "maker"},
    "content":  {"vertical": "content",  "lead_shape": "maker"},
    "market":   {"vertical": "research", "lead_shape": "maker"},
    "research": {"vertical": "research", "lead_shape": "maker"},
    "strategy": {"vertical": "strategy", "lead_shape": "panel"},
    "business": {"vertical": "strategy", "lead_shape": "panel"},
    "decision": {"vertical": "strategy", "lead_shape": "panel"},
    "general":  {"vertical": "general",  "lead_shape": "auto"},
    "hq":       {"vertical": "hq",       "lead_shape": "maker"},
}

_PRODUCE_OUTPUTS = {"doc", "sheet", "email", "report", "slides"}


def lead_shape_for(room_kind: str, intended_output: str = "") -> str:
    """maker | panel | auto. A produce output always forces maker."""
    if str(intended_output or "").lower() in _PRODUCE_OUTPUTS:
        return "maker"
    return (KIND_REGISTRY.get(str(room_kind or "").lower(), {}) or {}).get("lead_shape", "auto")


def shape_debate_members(members: List[Dict[str, Any]], shape: str) -> List[Dict[str, Any]]:
    """Trim/reorder the debate roster for the given lead shape.

    maker: 1 non-skeptic maker (lead) + at most 1 skeptic (reviewer) → 2 max, so
           the room writes the deliverable instead of convening a tribunal.
    panel/auto: unchanged (up to 5).
    """
    if shape != "maker" or len(members) <= 2:
        return members[:5]

    def _is_skeptic(m: Dict[str, Any]) -> bool:
        return "skeptic" in str(m.get("_lane") or m.get("role_archetype") or "").lower()

    makers = [m for m in members if not _is_skeptic(m)]
    skeptics = [m for m in members if _is_skeptic(m)]
    lead = makers[0] if makers else members[0]
    reviewer = (skeptics[0] if skeptics else (makers[1] if len(makers) > 1 else None))
    return [lead] + ([reviewer] if reviewer else [])
