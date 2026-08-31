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
