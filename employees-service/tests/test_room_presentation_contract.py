from hivemind_employees.api_hyper_rooms import _build_final_report


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
