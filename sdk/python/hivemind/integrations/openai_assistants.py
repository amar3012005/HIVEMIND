"""OpenAI Assistants drop-in replacement for `file_search`.

Replaces OpenAI's hosted file_search tool with HIVEMIND retrieval. Same
mental model — point at a knowledge store, the assistant retrieves context
automatically — but with EU sovereignty, audit trail, RBAC, and graph-aware
retrieval that OpenAI's file_search lacks.

Example (replace OpenAI file_search):
    from openai import OpenAI
    from hivemind import HiveMind
    from hivemind.integrations.openai_assistants import (
        HIVEMIND_TOOL_SPEC,
        handle_tool_call,
    )

    client = OpenAI()
    hm = HiveMind(api_key="hmk_live_...")

    # Create assistant with HIVEMIND retrieval tool instead of file_search
    assistant = client.beta.assistants.create(
        name="EU AI Act Compliance Bot",
        instructions="Answer using only HIVEMIND retrieval. Cite memory IDs.",
        model="gpt-4o",
        tools=[HIVEMIND_TOOL_SPEC],
    )

    # Standard OpenAI Assistants run loop — on requires_action, call handle_tool_call
    thread = client.beta.threads.create()
    client.beta.threads.messages.create(
        thread_id=thread.id,
        role="user",
        content="What are the EU AI Act deadlines for high-risk AI systems?",
    )
    run = client.beta.threads.runs.create(thread_id=thread.id, assistant_id=assistant.id)

    while run.status in ("queued", "in_progress", "requires_action"):
        if run.status == "requires_action":
            outputs = []
            for call in run.required_action.submit_tool_outputs.tool_calls:
                outputs.append(handle_tool_call(call, hm))
            run = client.beta.threads.runs.submit_tool_outputs(
                thread_id=thread.id, run_id=run.id, tool_outputs=outputs
            )
        else:
            run = client.beta.threads.runs.retrieve(thread_id=thread.id, run_id=run.id)
"""

from __future__ import annotations

import json
from typing import Any

from hivemind.client import HiveMind

# OpenAI Assistants tool spec — drop into `tools=[...]` on create
HIVEMIND_TOOL_SPEC: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "hivemind_search",
        "description": (
            "Search HIVEMIND company memory for relevant context. Returns ranked "
            "memories with provenance (source id, score, cluster). Use this BEFORE "
            "answering any question about company knowledge, internal decisions, "
            "team conversations, customer data, or historical context. Cite the "
            "source memory id in your answer."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Natural-language search query. Be specific.",
                },
                "n_results": {
                    "type": "integer",
                    "description": "How many results to return (1-20). Default 5.",
                    "default": 5,
                },
                "scope": {
                    "type": "string",
                    "enum": ["personal", "team", "all"],
                    "description": "Memory scope. Default 'team' for company-wide.",
                    "default": "team",
                },
                "tags": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Optional tag filter (e.g. ['eu-ai-act', 'compliance']).",
                },
            },
            "required": ["query"],
        },
    },
}


def handle_tool_call(tool_call: Any, hm: HiveMind) -> dict[str, Any]:
    """Execute a hivemind_search tool_call from OpenAI run.required_action.

    Args:
        tool_call: Single tool_call object from run.required_action.submit_tool_outputs.tool_calls
        hm: HiveMind client.

    Returns:
        dict shaped for submit_tool_outputs(tool_outputs=[...]).
    """
    args = json.loads(tool_call.function.arguments or "{}")
    query = args.get("query", "")
    if not query:
        return {
            "tool_call_id": tool_call.id,
            "output": json.dumps({"error": "Missing required 'query' argument."}),
        }

    results = hm.search(
        query,
        n_results=int(args.get("n_results", 5)),
        scope=args.get("scope", "team"),
        tags=args.get("tags"),
    )

    citations = [r.as_citation() for r in results]
    return {
        "tool_call_id": tool_call.id,
        "output": json.dumps(
            {
                "query": query,
                "n_results": len(citations),
                "results": citations,
                "instruction_to_assistant": (
                    "Use these results to answer. Cite memory IDs as [source: <id>]. "
                    "If no result is relevant enough, say so explicitly."
                ),
            }
        ),
    }


def build_assistant_kwargs(
    name: str,
    *,
    model: str = "gpt-4o",
    instructions_extra: str | None = None,
    extra_tools: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Convenience: build the kwargs dict for client.beta.assistants.create()
    pre-wired with HIVEMIND retrieval.
    """
    base_instructions = (
        "You are a HIVEMIND-powered assistant. Before answering any question "
        "about company knowledge, internal decisions, or historical context, "
        "call `hivemind_search` to retrieve relevant memories. Always cite the "
        "source memory ID in your final answer like [source: <id>]. If retrieval "
        "returns nothing relevant, say so honestly — do not hallucinate."
    )
    if instructions_extra:
        base_instructions = f"{base_instructions}\n\n{instructions_extra}"

    return {
        "name": name,
        "model": model,
        "instructions": base_instructions,
        "tools": [HIVEMIND_TOOL_SPEC, *(extra_tools or [])],
    }


__all__ = ["HIVEMIND_TOOL_SPEC", "handle_tool_call", "build_assistant_kwargs"]
