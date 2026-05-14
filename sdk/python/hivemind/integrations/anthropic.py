"""Anthropic Claude tool-use adapter for HIVEMIND.

Provides the tool definition + handler so you can give any Claude model
access to your HIVEMIND company brain in 3 lines.

Example:
    from anthropic import Anthropic
    from hivemind import HiveMind
    from hivemind.integrations.anthropic import HIVEMIND_TOOL_DEF, handle_tool_use

    client = Anthropic()
    hm = HiveMind(api_key="hmk_live_...")

    messages = [{"role": "user", "content": "What did we decide about pricing?"}]
    while True:
        resp = client.messages.create(
            model="claude-sonnet-4-5",
            max_tokens=1024,
            tools=[HIVEMIND_TOOL_DEF],
            messages=messages,
        )
        if resp.stop_reason != "tool_use":
            print(resp.content[0].text)
            break
        tool_use = next(b for b in resp.content if b.type == "tool_use")
        tool_result = handle_tool_use(tool_use, hm)
        messages.append({"role": "assistant", "content": resp.content})
        messages.append({"role": "user", "content": [tool_result]})
"""

from __future__ import annotations

import json
from typing import Any

from hivemind.client import HiveMind

HIVEMIND_TOOL_DEF: dict[str, Any] = {
    "name": "hivemind_search",
    "description": (
        "Search HIVEMIND company memory for relevant context. Returns ranked "
        "memories with provenance (source id, score, cluster). Use this BEFORE "
        "answering any question about company knowledge, internal decisions, "
        "team conversations, customer data, or historical context. Cite the "
        "source memory id in your final answer."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Natural-language search query. Be specific.",
            },
            "n_results": {
                "type": "integer",
                "description": "How many results (1-20). Default 5.",
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
                "description": "Optional tag filter.",
            },
        },
        "required": ["query"],
    },
}


def handle_tool_use(tool_use_block: Any, hm: HiveMind) -> dict[str, Any]:
    """Execute a hivemind_search tool_use block from a Claude response.

    Args:
        tool_use_block: a ToolUseBlock from response.content where type == 'tool_use'.
        hm: HiveMind client.

    Returns:
        dict shaped as a tool_result content block — append to messages.
    """
    args = tool_use_block.input or {}
    query = args.get("query", "")

    if not query:
        return {
            "type": "tool_result",
            "tool_use_id": tool_use_block.id,
            "is_error": True,
            "content": "Missing required 'query' argument.",
        }

    results = hm.search(
        query,
        n_results=int(args.get("n_results", 5)),
        scope=args.get("scope", "team"),
        tags=args.get("tags"),
    )

    citations = [r.as_citation() for r in results]
    return {
        "type": "tool_result",
        "tool_use_id": tool_use_block.id,
        "content": json.dumps(
            {
                "query": query,
                "n_results": len(citations),
                "results": citations,
            }
        ),
    }


__all__ = ["HIVEMIND_TOOL_DEF", "handle_tool_use"]
