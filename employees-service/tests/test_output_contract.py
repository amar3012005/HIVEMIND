from hivemind_employees.hyper.output_contract import (
    resolve_output_contract,
    artifact_intent_allowed,
    should_run_render_gate,
    labeled_unverified_draft,
)

BRIEF = (
    "Refine Positioning Statement for European Markets. Synthesize purpose, "
    "tagline, and sovereign memory technology. Test against competitor absence "
    "and regulatory focus, then create a brand voice guide."
)


def test_branding_brief_is_text_with_evidence():
    c = resolve_output_contract(user_message=BRIEF, room_kind="branding", room_mode="runtime")
    assert c["intended_output"] == "answer"
    assert c["artifact_required"] is False
    assert c["visual_enabled"] is False
    assert c["evidence_required"] is True
    assert artifact_intent_allowed(c, {"kind": "interactive_document"}) is False
    assert should_run_render_gate(c) is False


def test_explicit_deck_is_artifact():
    c = resolve_output_contract(user_message="Make a pitch deck for EU buyers", room_kind="branding")
    assert c["intended_output"] == "artifact"
    assert c["artifact_required"] is True
    assert should_run_render_gate(c) is True


def test_profile_can_force_visual():
    c = resolve_output_contract(
        user_message="positioning line",
        execution_profile={"profile_id": "design.visual.v1", "visual_artifact_required": True},
    )
    assert c["artifact_required"] is True


def test_draft_is_not_withheld():
    out = labeled_unverified_draft("Our offering is the only sovereign memory layer.", ["competitor set"])
    assert out.startswith("Draft.")
    assert "not withheld" in out.lower()
    assert "Our offering" in out
