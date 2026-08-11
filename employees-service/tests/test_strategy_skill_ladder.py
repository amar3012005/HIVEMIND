"""A Director can only select a skill it is shown. The strategy/market/business method
families lived on disk but `skill_catalog("marketing")` returned only the marketing domain
pack plus `general`, so a keystone strategy assignment fell back to generic evidence-first
prose while positioning, beachhead, channel and offer methods sat unused."""
from hivemind_employees.hyper.skills import load_method_skill, skill_catalog

LADDER = [
    "strategy-operating-loop", "strategy-kernel", "jtbd-trigger", "positioning-ladder",
    "beachhead-selection", "blue-ocean-canvas", "grand-slam-offer", "bullseye-channels",
    "challenger-reframe", "north-star-measures",
]


def test_marketing_room_can_see_the_whole_strategy_ladder():
    catalog = dict(skill_catalog("marketing"))
    missing = [name for name in LADDER if name not in catalog]
    assert not missing, f"invisible to a marketing Director: {missing}"


def test_every_ladder_skill_has_a_when_and_a_body():
    catalog = dict(skill_catalog("marketing"))
    for name in LADDER:
        assert catalog[name].strip(), f"{name} has an empty `when:` so it can never be matched"
        body = load_method_skill(name)
        assert len(body) > 200, f"{name} body too thin to change behaviour ({len(body)} chars)"


def test_catalog_has_no_duplicate_entries():
    names = [name for name, _ in skill_catalog("marketing")]
    assert len(names) == len(set(names)), "adjacent-kind widening must not duplicate a skill"


def test_operating_loop_states_the_monotonic_rule():
    body = load_method_skill("strategy-operating-loop")
    assert "prior_attempt" in body, "loop must tell the room where its previous draft is"
    assert "MONOTONIC" in body
    # The regression that made attempt 3 worse than attempt 2 must be named explicitly.
    assert "fewer populated fields" in body


def test_adjacent_widening_does_not_leak_into_unrelated_kinds():
    # A research room has no declared adjacency, so it must not inherit outreach methods.
    assert "challenger-reframe" not in dict(skill_catalog("research"))
