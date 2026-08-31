from hivemind_employees.api_hyper_rooms import (
    _build_final_report,
    _dead_end_message,
    _derive_intended_output,
)


def test_final_report_uses_the_polished_synthesis_without_generic_wrapper():
    synthesis = "# Market entry recommendation\n\n## Decision\nEnter through one focused segment."

    report = _build_final_report(
        user_message="Build a market entry recommendation",
        final_text=synthesis,
        template="auto",
        room_goal="Make the company ready to enter the market",
        status="complete",
    )

    assert report["content"] == synthesis
    assert "**Question:**" not in report["content"]
    assert "## Final report" not in report["content"]
    assert report["goal_progress"]["label"]


def test_content_creation_stays_in_the_room_without_a_named_provider():
    assert _derive_intended_output("Build Regulated Enterprise Audience Persona") == "answer"
    assert _derive_intended_output("Create a detailed report with an options table") == "answer"


def test_named_external_destination_remains_available():
    assert _derive_intended_output("Create this plan in Google Docs") == "doc"
    assert _derive_intended_output("Put these rows in Google Sheets") == "sheet"


def test_legacy_boolean_dead_end_renders_instead_of_crashing():
    message = _dead_end_message({"dead_end": True, "verification": {"memory_hits": 2}})

    assert "couldn't fully finish" in message
    assert "2 relevant memories found" in message


def test_structured_dead_end_preserves_exact_reason():
    message = _dead_end_message({
        "dead_end": {"reason": "the independent reviewer rejected the evidence"},
    })

    assert "independent reviewer rejected the evidence" in message
