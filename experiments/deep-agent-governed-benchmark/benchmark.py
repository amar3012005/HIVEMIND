"""Disposable Deep Agents comparison with synthetic Meta Tool receipts."""
import json
import os
import time
from langchain_core.tools import tool
from deepagents import create_deep_agent


@tool
def composio_search_tools(use_case: str) -> str:
    """Return synthetic capabilities for a language-neutral external use case."""
    return json.dumps({"session_id": "mock-session", "capabilities": [
        {"slug": "MOCK_LIST_RECORDS", "required": []},
        {"slug": "MOCK_GET_RECORD", "required": ["record_id"]},
        {"slug": "MOCK_SEARCH_PEOPLE", "required": ["query"]},
        {"slug": "MOCK_SEND_MESSAGE", "required": ["recipient", "subject", "body"]},
    ]})


@tool
def composio_get_tool_schemas(tool_slugs: list[str]) -> str:
    """Return bounded synthetic schemas for already discovered tool slugs."""
    return json.dumps({"schemas": {slug: {"type": "object"} for slug in tool_slugs}})


@tool
def composio_multi_execute_tool(tool_slug: str, arguments: dict) -> str:
    """Execute a synthetic read; write-shaped tools return a draft-only receipt."""
    if any(token in tool_slug for token in ("SEND", "CREATE", "UPDATE", "DELETE")):
        return json.dumps({"status": "approval_required", "executed": False})
    return json.dumps({"status": "completed", "receipt_id": "mock-receipt", "data": {"records": []}})


INSTRUCTIONS = """You benchmark dependency planning for a governed agent.
Use search first, fetch schemas only for selected capabilities, resolve unknown
identifiers through reads, and never execute a mutation: stop at an approval
draft. Return a concise final outcome and the tool trajectory."""

REQUESTS = [
    "What is my last professional-network post about?",
    "What is my professional-network profile?",
    "Draft an email to a named colleague about Singulance.",
]


def main() -> None:
    model = os.environ.get("DEEP_AGENT_MODEL")
    if not model:
        raise SystemExit("DEEP_AGENT_MODEL=provider:model is required")
    agent = create_deep_agent(
        model=model,
        tools=[composio_search_tools, composio_get_tool_schemas, composio_multi_execute_tool],
        system_prompt=INSTRUCTIONS,
    )
    for request in REQUESTS:
        started = time.perf_counter()
        result = agent.invoke({"messages": [{"role": "user", "content": request}]})
        trajectory = []
        schema_failures = 0
        for message in result.get("messages", []):
            for call in getattr(message, "tool_calls", []) or []:
                trajectory.append(call.get("name", "unknown"))
            if getattr(message, "type", "") == "tool" and "schema" in str(getattr(message, "content", "")).lower() and "error" in str(getattr(message, "content", "")).lower():
                schema_failures += 1
        print(json.dumps({
            "request": request,
            "duration_ms": round((time.perf_counter() - started) * 1000),
            "trajectory": trajectory,
            "context_chars": sum(len(str(getattr(message, "content", ""))) for message in result.get("messages", [])),
            "schema_validation_failures": schema_failures,
            "answer": str(result["messages"][-1].content),
        }, ensure_ascii=False))


if __name__ == "__main__":
    main()
