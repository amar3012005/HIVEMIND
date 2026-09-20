from hivemind_employees.hyper.output_contract import (
    resolve_output_contract,
    artifact_intent_allowed,
    should_run_render_gate,
    labeled_unverified_draft,
    split_goalkeeper_gaps,
)

BRIEF = (
    "Refine Positioning Statement for European Markets. Synthesize purpose, "
    "tagline, and sovereign memory technology. Test against competitor absence "
    "and regulatory focus, then create a brand voice guide."
)


def test_branding_brief_is_text_with_evidence():
    c = resolve_output_contract(user_message=BRIEF, room_kind="branding", room_mode="runtime")
    assert c["intended_output"] == "answer"
    assert c["intendedOutput"] == "answer"
    assert c["artifact_required"] is False
    assert c["artifactRequired"] is False
    assert c["visual_enabled"] is False
    assert c["evidence_required"] is True
    assert artifact_intent_allowed(c, {"kind": "interactive_document"}) is False
    assert should_run_render_gate(c) is False


def test_brand_voice_guide_is_not_a_visual_document():
    c = resolve_output_contract(user_message="create a brand voice guide", room_kind="branding")
    assert c["intended_output"] == "answer"
    assert c["artifact_required"] is False


def test_explicit_visual_guide_is_artifact():
    c = resolve_output_contract(user_message="create a visual guide of the brand system")
    assert c["intended_output"] == "artifact"
    assert c["artifact_required"] is True
    assert should_run_render_gate(c) is True


def test_explicit_generated_image_uses_durable_visual_contract():
    c = resolve_output_contract(
        user_message="Create three coordinated 16:9 campaign visuals for the launch"
    )
    assert c["intended_output"] == "artifact"
    assert c["artifact_required"] is True
    assert c["artifact_kind"] == "generated_image"
    assert should_run_render_gate(c) is False


def test_direct_visual_language_uses_durable_visual_contract_in_any_room():
    for message in (
        "I need a visual for this launch",
        "Give me a final visual",
        "Create the campaign plan and a visual artifact",
        "Produce an image set after the research is complete",
    ):
        c = resolve_output_contract(
            user_message=message,
            room_kind="general",
            room_mode="work",
        )
        assert c["artifact_required"] is True
        assert c["artifact_kind"] == "generated_image"


def test_direct_logo_request_uses_generated_image_contract_inside_campaign_room():
    c = resolve_output_contract(
        user_message="create me a new logo for solvis",
        room_kind="campaign",
        room_mode="work",
    )
    assert c["intended_output"] == "artifact"
    assert c["artifact_required"] is True
    assert c["artifact_kind"] == "generated_image"


def test_explicit_three_image_request_overrides_visual_profile_without_html_render_gate():
    c = resolve_output_contract(
        user_message="now if i were to do a instagram post for 3 imags, generate me 3 images",
        room_kind="design",
        room_mode="work",
        execution_profile={
            "profile_id": "design.artifact.v1",
            "visual_artifact_required": True,
            "allowed_outputs": ["artifact"],
            "required_artifacts": ["visual"],
        },
    )
    assert c["artifact_kind"] == "generated_image"
    assert should_run_render_gate(c) is False


def test_explicit_deck_is_artifact():
    c = resolve_output_contract(user_message="Make a pitch deck for EU buyers", room_kind="branding")
    assert c["intended_output"] == "artifact"
    assert c["artifact_required"] is True
    assert should_run_render_gate(c) is True


def test_explicit_document_is_artifact():
    c = resolve_output_contract(user_message="create a document for EU buyers")
    assert c["intended_output"] == "artifact"
    assert c["artifact_required"] is True


def test_explicit_dashboard_is_artifact():
    c = resolve_output_contract(user_message="build a dashboard of competitor coverage")
    assert c["intended_output"] == "artifact"
    assert c["artifact_required"] is True
    assert c["evidence_required"] is True


def test_profile_can_force_visual():
    c = resolve_output_contract(
        user_message="positioning line",
        execution_profile={"profile_id": "design.visual.v1", "visual_artifact_required": True},
    )
    assert c["artifact_required"] is True
    assert should_run_render_gate(c) is True


def test_draft_is_not_withheld():
    out = labeled_unverified_draft("Our offering is the only sovereign memory layer.", ["competitor set"])
    assert out.startswith("Draft.")
    assert "not withheld" in out.lower()
    assert "Our offering" in out
    assert "Ask again" not in out


def test_split_drops_render_gaps_on_text_contract():
    c = resolve_output_contract(user_message=BRIEF, room_kind="branding")
    kept, dropped = split_goalkeeper_gaps(
        [
            "competitor set",
            "The requested interactive artifact did not pass production rendering checks.",
        ],
        c,
    )
    assert kept == ["competitor set"]
    assert dropped and "production rendering checks" in dropped[0]


def test_split_keeps_render_gaps_when_artifact_is_required():
    c = resolve_output_contract(user_message="Make a pitch deck for EU buyers")
    kept, dropped = split_goalkeeper_gaps(
        ["The requested interactive artifact did not pass production rendering checks."],
        c,
    )
    assert kept
    assert dropped == []


def test_research_floor_applies_without_work_room_profile():
    from hivemind_employees.hyper.engine import Director

    director = object.__new__(Director)
    director.execution_profile = {}
    director.user_message = BRIEF
    director.output_contract = resolve_output_contract(
        user_message=BRIEF, room_kind="branding", room_mode="runtime",
    )
    director._web_budget = 1
    plan = director._apply_research_floor({
        "recall_queries": [],
        "web_query": None,
        "connector_calls": [],
    })
    assert plan["recall_queries"]
    assert plan["web_query"]
    assert plan["research_floor"] == "output_contract.evidence_required"
    assert plan["turn_mode"] == "task"


def test_evidence_contract_extracts_the_explicit_company_url():
    from hivemind_employees.hyper.engine import Director

    prompt = (
        "Map competitors and the local market for Solvis GmbH. "
        "Start from https://solvis.de and cite every market claim."
    )
    director = object.__new__(Director)
    director.execution_profile = {}
    director.user_message = prompt
    director.company_brief = "Company: Solvis GmbH\nWebsite: https://solvis.de\nLocation: Hannover"
    director.output_contract = resolve_output_contract(user_message=prompt, room_kind="research")
    director._web_budget = 1

    plan = director._apply_research_floor({
        "recall_queries": [], "web_query": None, "connector_calls": [],
    })

    assert plan["web_query"]
    assert plan["extract_urls"] == ["https://solvis.de"]
    assert plan["extract_page_limit"] == 12
