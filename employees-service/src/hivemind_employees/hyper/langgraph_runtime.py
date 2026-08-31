"""Bounded cognition graph for one durable HyperAgent assignment.

Cloudflare Workflow and PostgreSQL own retries, checkpoints, leases, and
idempotency.  This graph owns only the in-process cognitive sequence around a
single AgentScope worker invocation and deliberately has no checkpointer.
"""
from __future__ import annotations

import asyncio
from typing import Any, Awaitable, Callable, Dict, Literal, TypedDict

from langgraph.graph import END, START, StateGraph


AgentExecutor = Callable[[Dict[str, Any], Dict[str, Any], str], Awaitable[Dict[str, Any]]]


class AssignmentState(TypedDict, total=False):
    employee: Dict[str, Any]
    order: Dict[str, Any]
    prompt: str
    executor: AgentExecutor
    result: Dict[str, Any]
    attempts: int
    max_repairs: int
    unmet: list[str]


async def _execute(state: AssignmentState) -> Dict[str, Any]:
    attempts = int(state.get("attempts") or 0) + 1
    result = await state["executor"](state["employee"], state["order"], state["prompt"])
    return {"result": result or {}, "attempts": attempts}


def _self_check(state: AssignmentState) -> Dict[str, Any]:
    result = state.get("result") or {}
    unmet: list[str] = []
    if not str(result.get("text") or "").strip():
        unmet.append("agent returned no usable result")
    if not isinstance(result.get("tool_receipts") or [], list):
        unmet.append("tool receipts must be a list")
    if not isinstance(result.get("evidence") or [], list):
        unmet.append("evidence must be a list")
    if not isinstance(result.get("artifacts") or [], list):
        unmet.append("artifacts must be a list")
    return {"unmet": unmet}


def _route(state: AssignmentState) -> Literal["repair", "done"]:
    if state.get("unmet") and int(state.get("attempts") or 0) <= int(state.get("max_repairs") or 0):
        return "repair"
    return "done"


def _repair(state: AssignmentState) -> Dict[str, Any]:
    gaps = "; ".join(state.get("unmet") or [])
    return {
        "prompt": (
            f"{state['prompt']}\n\nSELF-CHECK REPAIR: The previous attempt failed these generic checks: {gaps}. "
            "Return a corrected bounded result without changing the assignment or inventing evidence."
        ),
    }


def _build_graph():
    graph = StateGraph(AssignmentState)
    graph.add_node("execute", _execute)
    graph.add_node("self_check", _self_check)
    graph.add_node("repair", _repair)
    graph.add_edge(START, "execute")
    graph.add_edge("execute", "self_check")
    graph.add_conditional_edges("self_check", _route, {"repair": "repair", "done": END})
    graph.add_edge("repair", "execute")
    return graph.compile()


_ASSIGNMENT_GRAPH = _build_graph()


async def run_bounded_assignment_graph(
    executor: AgentExecutor,
    employee: Dict[str, Any],
    order: Dict[str, Any],
    prompt: str,
    *,
    max_repairs: int = 1,
    max_input_chars: int = 24_000,
    max_output_chars: int = 32_000,
    max_tool_receipts: int = 16,
    wall_timeout_seconds: float = 240.0,
) -> Dict[str, Any]:
    """Run one isolated AgentScope assignment through the bounded graph.

    These are cognitive bounds only.  Durable retries and checkpoint recovery
    remain the responsibility of the surrounding Workflow/PostgreSQL executor.
    """
    input_limit = max(4_000, min(64_000, int(max_input_chars)))
    output_limit = max(2_000, min(64_000, int(max_output_chars)))
    receipt_limit = max(1, min(64, int(max_tool_receipts)))
    state = await asyncio.wait_for(
        _ASSIGNMENT_GRAPH.ainvoke({
            "executor": executor,
            "employee": employee,
            "order": order,
            "prompt": str(prompt)[:input_limit],
            "attempts": 0,
            "max_repairs": max(0, min(2, int(max_repairs))),
            "result": {},
            "unmet": [],
        }),
        timeout=max(30.0, min(900.0, float(wall_timeout_seconds))),
    )
    if state.get("unmet"):
        raise RuntimeError("assignment self-check failed: " + "; ".join(state["unmet"]))
    result = dict(state.get("result") or {})
    if len(str(result.get("text") or "")) > output_limit:
        raise RuntimeError("assignment output budget exceeded")
    receipts = result.get("tool_receipts") or []
    if len(receipts) > receipt_limit:
        raise RuntimeError("assignment tool-call budget exceeded")
    usage = dict(result.get("usage") or {})
    usage.update({
        "cognitive_attempts": int(state.get("attempts") or 0),
        "max_repairs": max(0, min(2, int(max_repairs))),
        "max_input_chars": input_limit,
        "max_output_chars": output_limit,
        "max_tool_receipts": receipt_limit,
        "wall_timeout_seconds": max(30.0, min(900.0, float(wall_timeout_seconds))),
    })
    result["usage"] = usage
    return result
