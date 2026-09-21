"""Content-free AgentScope lifecycle evaluation.

This is deliberately an evaluation helper, not a second execution loop. It
checks the ordering guarantees the WorkRun UI depends on while leaving the
native AgentScope event payload and execution semantics untouched.
"""

from __future__ import annotations


TERMINAL_TYPES = {"REPLY_END", "workrun.completed", "workrun.failed", "workrun.cancelled"}
THINKING_TYPES = {"THINKING_BLOCK_DELTA", "thinking.delta"}
TOOL_TYPES = {"TOOL_CALL_START", "tool.started"}
ANSWER_TYPES = {"TEXT_BLOCK_DELTA", "text.delta"}


def validate_lifecycle(events: list[dict]) -> dict:
    """Return a deterministic, content-free verdict for one streamed turn."""
    errors: list[str] = []
    seen_ids: set[str] = set()
    phases: list[str] = []
    terminal_count = 0
    for index, event in enumerate(events or []):
        if not isinstance(event, dict):
            errors.append(f"event[{index}] is not an object")
            continue
        event_id = event.get("id") or event.get("event_id") or event.get("source_event_id")
        if event_id:
            if event_id in seen_ids:
                errors.append(f"duplicate event id: {event_id}")
            seen_ids.add(event_id)
        kind = str(event.get("type") or event.get("t") or "")
        if kind in {"REPLY_START", "workrun.started", "agent.status"}:
            phases.append("acknowledgement")
        elif kind in THINKING_TYPES:
            phases.append("thinking")
        elif kind in TOOL_TYPES:
            phases.append("tool")
        elif kind in ANSWER_TYPES or kind == "assistant.delta":
            if kind == "assistant.delta" and "text" not in str(event.get("type") or "").lower():
                continue
            phases.append("answer")
        elif kind in TERMINAL_TYPES:
            phases.append("terminal")
            terminal_count += 1

    if not phases or phases[0] != "acknowledgement":
        errors.append("stream must begin with acknowledgement")
    if terminal_count != 1:
        errors.append(f"expected exactly one terminal event, got {terminal_count}")
    if "answer" in phases and "terminal" in phases and phases.index("answer") > phases.index("terminal"):
        errors.append("answer must precede terminal")
    if "terminal" in phases and phases[-1] != "terminal":
        errors.append("terminal event must be last")
    return {"ok": not errors, "errors": errors, "phases": phases, "event_count": len(events or [])}

