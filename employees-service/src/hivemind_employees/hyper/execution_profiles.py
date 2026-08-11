"""Execution-profile registry for human Work Room turns.

The problem this closes: a human Work Room's `room_kind` was fixed to "general"
for the lifetime of the room (`resolve_turn_room_kind` hard-returns "general"
whenever `room_mode == "work"` — see `hyper/skills/__init__.py`). A General
Work Room could therefore never invoke the Campaign compiler, the Outreach
lifecycle contract, or any other specialist engine deterministically — it could
only improvise a generic report while borrowing a method skill for flavor.
`self.room_kind` gates ~40 branches across `engine.py` (domain pack load,
`outreach_request` population, the campaign-contract system prompt, ...), so
correctly setting `room_kind` for ONE turn reactivates all of that existing,
already-working machinery for free. This registry is the data half of that
fix: it maps a Director's semantic profile choice to (a) which existing
`room_kind` to run the turn as, and (b) whether that profile's output is a
judgement call (never withhold, degrade honestly — the shipped Work Room
fail-safe policy already does this) or an operational artifact set (never
substitute a prose report for the real persisted evidence).

Each profile is DATA, not engine branching. Adding a profile must never
require touching `engine.py`; if a profile needs new engine behavior, that
behavior belongs behind its own `room_kind`/domain-pack gate, same as every
existing specialist path.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple


@dataclass(frozen=True)
class ExecutionProfile:
    id: str
    room_kind: str
    allowed_outputs: Tuple[str, ...]
    # "internal": no external world effect, no evidence-strictness beyond the
    #   Work Room's existing verification-advisory policy (general.answer).
    # "prepare_only": produces durable internal artifacts (leads, drafts, call
    #   briefs, a campaign contract) but performs no provider action — the
    #   completion policy for these profiles requires exactly the artifacts
    #   declared in `required_artifacts`, and PROSE ALONE MUST NEVER SATISFY IT.
    effect: str
    required_artifacts: Tuple[str, ...] = ()
    review_policy: str = "none"  # none | reviewer | debate
    external_authority: bool = False

    def is_operational(self) -> bool:
        """True when a generic report can never substitute for real artifacts."""
        return bool(self.required_artifacts)


# room_kind values must resolve to an installed domain pack (or "general",
# which has no pack — get_domain_pack("general") returns None by design, and
# Director already handles that: `self.domain_pack = get_domain_pack(self.room_kind)`).
EXECUTION_PROFILES: Dict[str, ExecutionProfile] = {
    p.id: p for p in (
        ExecutionProfile(
            id="general.answer.v1", room_kind="general",
            allowed_outputs=("direct_answer",), effect="internal",
        ),
        ExecutionProfile(
            id="research.decision.v1", room_kind="research",
            allowed_outputs=("report",), effect="prepare_only",
            required_artifacts=("source_ledger", "decision_artifact"),
            review_policy="reviewer",
        ),
        ExecutionProfile(
            id="campaign.contract.v1", room_kind="campaign",
            allowed_outputs=("campaign_board",), effect="prepare_only",
            required_artifacts=("campaign_contract",),
            review_policy="debate",
        ),
        ExecutionProfile(
            id="outreach.prepare.v1", room_kind="outreach",
            allowed_outputs=("outreach_dashboard",), effect="prepare_only",
            required_artifacts=(
                "source_backed_lead", "message_draft_for_verified_recipient",
                "call_brief_for_verified_phone",
            ),
            review_policy="reviewer",
        ),
        ExecutionProfile(
            id="marketing.artifact.v1", room_kind="marketing",
            allowed_outputs=("artifact",), effect="prepare_only",
            required_artifacts=("marketing_artifact",),
            review_policy="reviewer",
        ),
        ExecutionProfile(
            id="seo.audit.v1", room_kind="seo",
            allowed_outputs=("report",), effect="prepare_only",
            required_artifacts=("seo_evidence",),
        ),
        ExecutionProfile(
            id="branding.artifact.v1", room_kind="branding",
            allowed_outputs=("artifact",), effect="prepare_only",
            required_artifacts=("branding_artifact",),
        ),
        ExecutionProfile(
            id="fundraising.artifact.v1", room_kind="fundraising",
            allowed_outputs=("artifact",), effect="prepare_only",
            required_artifacts=("fundraising_artifact",),
        ),
        ExecutionProfile(
            id="product.artifact.v1", room_kind="product",
            allowed_outputs=("artifact",), effect="prepare_only",
            required_artifacts=("product_artifact",),
        ),
        ExecutionProfile(
            id="design.artifact.v1", room_kind="design",
            allowed_outputs=("artifact",), effect="prepare_only",
            required_artifacts=("design_artifact",),
        ),
        ExecutionProfile(
            id="legal_finance.review.v1", room_kind="legal_finance",
            allowed_outputs=("report",), effect="prepare_only",
            required_artifacts=("review_artifact",),
            review_policy="reviewer",
        ),
    )
}

DEFAULT_PROFILE_ID = "general.answer.v1"


def get_execution_profile(profile_id: str) -> Optional[ExecutionProfile]:
    return EXECUTION_PROFILES.get(str(profile_id or "").strip())


def default_execution_profile() -> ExecutionProfile:
    return EXECUTION_PROFILES[DEFAULT_PROFILE_ID]


def profile_registry_manifest() -> List[Dict[str, object]]:
    """Compact (id, room_kind, allowed_outputs, effect) rows for the selector
    prompt — the selector sees the registry shape, never engine internals."""
    return [
        {
            "profile_id": p.id, "room_kind": p.room_kind,
            "allowed_outputs": list(p.allowed_outputs), "effect": p.effect,
        }
        for p in EXECUTION_PROFILES.values()
    ]
