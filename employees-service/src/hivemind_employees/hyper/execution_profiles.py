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
    # One-line natural-language trigger shown to the selector model. Without
    # this the selector only sees id/room_kind/allowed_outputs/effect — bare
    # labels it disambiguates by string vibes alone (confirmed: "prioritize
    # 8 feature requests" picked research.decision.v1 over product.artifact.v1
    # because "decision" pattern-matched harder than the unexplained "product").
    when: str = ""

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
            when="Default. A direct question, opinion, or judgement call that "
                 "does not ask to build/audit/draft a named deliverable.",
        ),
        ExecutionProfile(
            id="research.decision.v1", room_kind="research",
            allowed_outputs=("report",), effect="prepare_only",
            required_artifacts=("source_ledger", "decision_artifact"),
            review_policy="reviewer",
            when="Asks to research external facts (competitors, market, a "
                 "named entity) and recommend a choice BETWEEN options found "
                 "via that research. Not for prioritizing a list the user "
                 "already supplied — that is product.artifact.v1 if the list "
                 "is features/backlog, or general.answer.v1 otherwise.",
        ),
        ExecutionProfile(
            id="campaign.contract.v1", room_kind="campaign",
            allowed_outputs=("campaign_board",), effect="prepare_only",
            required_artifacts=("campaign_contract",),
            review_policy="debate",
            when="Asks to build/plan a multi-step marketing or outreach "
                 "CAMPAIGN with a channel, cadence, or launch window — wants "
                 "a campaign contract/plan artifact, not a single asset.",
        ),
        ExecutionProfile(
            id="outreach.prepare.v1", room_kind="outreach",
            allowed_outputs=("outreach_dashboard",), effect="prepare_only",
            required_artifacts=(
                "source_backed_lead", "message_draft_for_verified_recipient",
                "call_brief_for_verified_phone",
            ),
            review_policy="reviewer",
            when="Asks to find/contact specific real people or companies "
                 "(leads, prospects, named recipients) — wants sourced leads "
                 "and outbound message/call drafts, not campaign strategy.",
        ),
        ExecutionProfile(
            id="marketing.copy.v1", room_kind="marketing",
            allowed_outputs=("direct_answer",), effect="internal",
            review_policy="reviewer",
            when="Asks to write or refine concise marketing or positioning text "
                 "such as a tagline, value proposition, message, headline, or "
                 "narrative statement, without asking for a designed visual/file.",
        ),
        ExecutionProfile(
            id="marketing.artifact.v1", room_kind="marketing",
            allowed_outputs=("artifact",), effect="prepare_only",
            required_artifacts=("marketing_artifact",),
            review_policy="reviewer",
            when="Explicitly asks to create a designed marketing asset or "
                 "visual collateral file/page. Plain taglines, headlines, "
                 "positioning statements, and copy use marketing.copy.v1.",
        ),
        ExecutionProfile(
            id="seo.audit.v1", room_kind="seo",
            allowed_outputs=("report",), effect="prepare_only",
            required_artifacts=("seo_evidence",),
            when="Asks to audit a website's SEO/technical search visibility "
                 "and report concrete issues found on that site.",
        ),
        ExecutionProfile(
            id="branding.artifact.v1", room_kind="branding",
            allowed_outputs=("artifact",), effect="prepare_only",
            required_artifacts=("branding_artifact",),
            when="Asks to define or critique brand identity itself — voice, "
                 "tone, personality, visual/verbal identity, archetype — not "
                 "a specific piece of marketing copy.",
        ),
        ExecutionProfile(
            id="fundraising.artifact.v1", room_kind="fundraising",
            allowed_outputs=("artifact",), effect="prepare_only",
            required_artifacts=("fundraising_artifact",),
            when="Asks to draft investor-facing fundraising material — pitch "
                 "narrative, deck story, cap table/SAFE math — for raising "
                 "capital from investors.",
        ),
        ExecutionProfile(
            id="product.artifact.v1", room_kind="product",
            allowed_outputs=("artifact",), effect="prepare_only",
            required_artifacts=("product_artifact",),
            when="Asks to prioritize, scope, or classify PRODUCT work the "
                 "user already listed — features, backlog items, bugs, "
                 "requirements — into a ranked/scoped artifact. If the user "
                 "supplies the candidates and wants them ranked or scoped, "
                 "this wins over research.decision.v1 even if they say "
                 "'decide' or 'help me decide.'",
        ),
        ExecutionProfile(
            id="design.artifact.v1", room_kind="design",
            allowed_outputs=("artifact",), effect="prepare_only",
            required_artifacts=("design_artifact",),
            when="Asks to critique or design UX/UI — usability of a flow, "
                 "screen, or interaction pattern.",
        ),
        ExecutionProfile(
            id="legal_finance.review.v1", room_kind="legal_finance",
            allowed_outputs=("report",), effect="prepare_only",
            required_artifacts=("review_artifact",),
            review_policy="reviewer",
            when="Asks to review legal/financial risk in a contract, deal "
                 "term, or financial position and flag concerns.",
        ),
    )
}

DEFAULT_PROFILE_ID = "general.answer.v1"


def get_execution_profile(profile_id: str) -> Optional[ExecutionProfile]:
    return EXECUTION_PROFILES.get(str(profile_id or "").strip())


def default_execution_profile() -> ExecutionProfile:
    return EXECUTION_PROFILES[DEFAULT_PROFILE_ID]


def profile_registry_manifest() -> List[Dict[str, object]]:
    """Compact (id, room_kind, allowed_outputs, effect, when) rows for the
    selector prompt — the registry shape, never engine internals. `when` is
    the only disambiguating signal the selector model gets; without it every
    profile is just bare labels (see `ExecutionProfile.when` docstring)."""
    return [
        {
            "profile_id": p.id, "room_kind": p.room_kind,
            "allowed_outputs": list(p.allowed_outputs), "effect": p.effect,
            "when": p.when,
        }
        for p in EXECUTION_PROFILES.values()
    ]
