import asyncio

import pytest

from hivemind_employees.hyper.langgraph_runtime import run_bounded_assignment_graph


def test_assignment_graph_repairs_empty_result_once():
    calls = []

    async def execute(_employee, _order, prompt):
        calls.append(prompt)
        if len(calls) == 1:
            return {"text": "", "tool_receipts": [], "evidence": [], "artifacts": []}
        return {"text": "verified result", "tool_receipts": [], "evidence": [], "artifacts": []}

    result = asyncio.run(run_bounded_assignment_graph(execute, {"id": "agent"}, {"id": "work"}, "do work"))

    assert result["text"] == "verified result"
    assert len(calls) == 2
    assert "SELF-CHECK REPAIR" in calls[1]


def test_assignment_graph_fails_after_bounded_repairs():
    async def execute(_employee, _order, _prompt):
        return {"text": "", "tool_receipts": [], "evidence": [], "artifacts": []}

    with pytest.raises(RuntimeError, match="no usable result"):
        asyncio.run(run_bounded_assignment_graph(
            execute, {"id": "agent"}, {"id": "work"}, "do work", max_repairs=1,
        ))


def test_assignment_graph_enforces_output_and_receipt_budgets():
    async def oversized(_employee, _order, _prompt):
        return {"text": "x" * 2001, "tool_receipts": [], "evidence": [], "artifacts": []}

    with pytest.raises(RuntimeError, match="output budget"):
        asyncio.run(run_bounded_assignment_graph(
            oversized, {"id": "agent"}, {"id": "work"}, "do work",
            max_output_chars=2000,
        ))

    async def too_many_tools(_employee, _order, _prompt):
        return {
            "text": "done", "tool_receipts": [{"id": "1"}, {"id": "2"}],
            "evidence": [], "artifacts": [],
        }

    with pytest.raises(RuntimeError, match="tool-call budget"):
        asyncio.run(run_bounded_assignment_graph(
            too_many_tools, {"id": "agent"}, {"id": "work"}, "do work",
            max_tool_receipts=1,
        ))


def test_assignment_graph_bounds_input_and_records_effective_limits():
    prompts = []

    async def execute(_employee, _order, prompt):
        prompts.append(prompt)
        return {"text": "done", "tool_receipts": [], "evidence": [], "artifacts": []}

    result = asyncio.run(run_bounded_assignment_graph(
        execute, {"id": "agent"}, {"id": "work"}, "x" * 5000,
        max_input_chars=4000, max_repairs=0, wall_timeout_seconds=30,
    ))
    assert len(prompts[0]) == 4000
    assert result["usage"]["max_input_chars"] == 4000
    assert result["usage"]["cognitive_attempts"] == 1
