"""HIVEMIND is the company brain — recall must not silently disappear.

Root cause: `requested_tools = employee_row.get("tools") or [wide_default]` was a
bare `or`, so ANY configured tools list (even one missing hivemind_recall) discarded
the wide default entirely. Confirmed live 2026-08-12: a real turn asking to
prioritize named HIVEMIND/TARA/HYPERAGENTS/RUNTIME features issued zero recall
queries and the lead agent had no recall tool to fall back on. resolve_agent_tool_names
fixes this while preserving the sentinel toolless agents (verifier, planner) that
deliberately run with NO tools.
"""
from hivemind_employees.agents.agentscope_factory import resolve_agent_tool_names


def test_no_configured_tools_gets_the_wide_default_including_recall():
    tools = resolve_agent_tool_names(None)
    assert "hivemind_recall" in tools
    assert tools == [
        "hivemind_recall", "hivemind_list_memories", "hivemind_get_memory",
        "hivemind_traverse_graph", "hivemind_query_with_ai", "hivemind_save_memory",
    ]


def test_empty_list_also_gets_the_wide_default():
    assert "hivemind_recall" in resolve_agent_tool_names([])


def test_configured_tools_missing_recall_get_it_merged_in():
    # The exact failure mode: a room agent set up with just a connector, no
    # hivemind_recall — used to silently lose ALL company-memory access.
    tools = resolve_agent_tool_names(["gmail_search"])
    assert "hivemind_recall" in tools
    assert "gmail_search" in tools


def test_configured_tools_already_including_recall_are_not_duplicated():
    tools = resolve_agent_tool_names(["hivemind_recall", "gmail_search"])
    assert tools.count("hivemind_recall") == 1
    assert tools == ["hivemind_recall", "gmail_search"]


def test_verifier_sentinel_toolless_list_is_left_untouched():
    # The verifier's ["_verify_noop"] must NEVER gain tools — it exists to keep
    # judgment pure with zero tool-call drift.
    assert resolve_agent_tool_names(["_verify_noop"]) == ["_verify_noop"]


def test_planner_sentinel_toolless_list_is_left_untouched():
    assert resolve_agent_tool_names(["_plan_noop"]) == ["_plan_noop"]
