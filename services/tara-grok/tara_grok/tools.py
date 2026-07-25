"""Canonical function-tool declarations. xAI server tools are supplied only by Core snapshots."""
from __future__ import annotations

from .core_client import run_tool

TOOL_SCHEMAS = [
    {"type": "function", "name": "hivemind_recall", "description": "Retrieve compact evidence only when an organizational fact is not grounded in this conversation.", "parameters": {"type": "object", "properties": {"query": {"type": "string", "maxLength": 500}}, "required": ["query"], "additionalProperties": False}},
    {"type": "function", "name": "commit_strategy_state", "description": "Persist concise auditable strategic state after a material turn; never include hidden reasoning.", "parameters": {"type": "object", "properties": {"phase": {"type": "string"}, "hypotheses": {"type": "array"}, "next_question_intent": {"type": "string"}, "directive": {"type": "string"}, "goal_progress": {"type": "string"}, "red_flags": {"type": "array"}, "stop_reason": {"type": "string"}}, "additionalProperties": False}},
]

async def execute(session_id: str, name: str, arguments: dict) -> dict:
    # Core derives the tenant and access scope from the consumed session, never model input.
    return await run_tool(session_id, name, arguments)
