"""Content-free acceptance contract for progressive company-task routing."""

from __future__ import annotations


def validate_company_task(events: list[dict]) -> dict:
    """Validate the observable AgentScope/HIVE layer order.

    The evaluator deliberately checks event identities and ordering, never
    model prose. Direct answers may skip the company-task layers; company work
    must expose the progressive context and execution layers before terminal.
    """
    rows = [event for event in events if isinstance(event, dict)]
    types = [str(event.get("type") or event.get("t") or "").upper() for event in rows]
    tools = [str(event.get("tool_call_name") or event.get("tool") or "") for event in rows]
    errors: list[str] = []
    if not types or types[0] not in {"REPLY_START", "WORKRUN.STARTED", "AGENT.STATUS"}:
        errors.append("stream must begin with acknowledgement")
    terminal = [index for index, kind in enumerate(types) if kind in {"REPLY_END", "WORKRUN.COMPLETED", "WORKRUN.FAILED"}]
    if len(terminal) != 1:
        errors.append("stream must contain exactly one terminal event")
    if terminal and terminal[0] != len(types) - 1:
        errors.append("terminal event must be last")
    answer = [index for index, kind in enumerate(types) if kind in {"TEXT_BLOCK_DELTA", "TEXT_BLOCK_END", "ASSISTANT.DELTA"}]
    if not answer:
        errors.append("stream must contain an answer")

    company_markers = {"HIVEMIND_COMPANY_CONTEXT", "PLAYBOOKLIST", "PLAYBOOKGET", "TASKCREATE", "SKILLVIEWER"}
    company_work = bool(company_markers.intersection({tool.upper() for tool in tools}))
    if company_work:
        positions = {marker: next((i for i, tool in enumerate(tools) if tool.upper() == marker), None) for marker in company_markers}
        if positions["HIVEMIND_COMPANY_CONTEXT"] is None:
            errors.append("company work must load company context")
        if positions["PLAYBOOKLIST"] is None or positions["PLAYBOOKGET"] is None:
            errors.append("company work must resolve a playbook through list/get")
        elif positions["PLAYBOOKLIST"] > positions["PLAYBOOKGET"]:
            errors.append("PlaybookList must precede PlaybookGet")
        if positions["TASKCREATE"] is None:
            errors.append("company work must create a native task plan")
        if positions["SKILLVIEWER"] is None:
            errors.append("company work must load the selected Skill on demand")
        if answer and any(position is not None and position > answer[0] for position in positions.values()):
            errors.append("company-task layers must precede the answer")
    return {"ok": not errors, "errors": errors, "company_work": company_work}
