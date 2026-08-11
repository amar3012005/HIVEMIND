from hivemind_employees.api_hyper_rooms import _build_final_report, _derive_intended_output


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
