"""Deterministic result contract for HQ-delegated Room work."""

from __future__ import annotations

import copy
from typing import Any

WORK_ORDER_CONTRACT = "work-order-result.v2"
_CHECKPOINT_DISPOSITIONS = {
    "complete", "continue_room", "wait_event", "wait_capability", "request_hq",
}


def _proposed_actions(authored: dict[str, Any]) -> list[dict[str, Any]]:
    actions = []
    for value in authored.get("proposed_actions") or []:
        if not isinstance(value, dict):
            continue
        capability = str(value.get("capability") or "").strip()
        operation = str(value.get("operation") or "").strip()
        if not capability or not operation:
            continue
        actions.append({
            "capability": capability[:160],
            "operation": operation[:160],
            "target_hint": str(value.get("target_hint") or "").strip()[:500] or None,
            "connected": bool(value.get("connected")),
            "authority_required": value.get("authority_required") is not False,
            "status": str(value.get("status") or "requested").strip().lower()[:40],
        })
    return actions[:20]


def _actual_counts(authored: dict[str, Any], metrics: dict[str, Any]) -> dict[str, int]:
    counts: dict[str, int] = {}
    raw_counts = authored.get("actual_counts")
    for key, value in (raw_counts.items() if isinstance(raw_counts, dict) else []):
        name = str(key or "").strip()[:120]
        if not name:
            continue
        try:
            counts[name] = max(0, int(value or 0))
        except (TypeError, ValueError):
            continue
    counts.setdefault("records_created", int(metrics.get("records_created") or 0))
    counts.setdefault("records_persisted", int(metrics.get("records_persisted") or 0))
    counts.setdefault("tool_calls_total", int(metrics.get("tool_calls_total") or 0))
    return counts


def _checkpoint(authored: dict[str, Any], status: str) -> dict[str, Any]:
    value = authored.get("checkpoint") if isinstance(authored.get("checkpoint"), dict) else {}
    disposition = str(value.get("disposition") or "").strip().lower()
    if status == "completed":
        disposition = "complete"
    elif disposition not in _CHECKPOINT_DISPOSITIONS:
        disposition = "continue_room" if authored.get("deliverables") else "request_hq"
    return {
        "stage": str(value.get("stage") or "work_order").strip()[:120],
        "completed": [str(item).strip()[:120] for item in (value.get("completed") or []) if str(item).strip()][:20],
        "next": str(value.get("next") or "").strip()[:240] or None,
        "disposition": disposition,
        "reason": str(value.get("reason") or "").strip()[:1000],
        "requires": [str(item).strip()[:240] for item in (value.get("requires") or []) if str(item).strip()][:20],
    }


def assemble_work_order_result(
    semantic: Any,
    *,
    envelope: dict[str, Any],
    subtasks: list[dict[str, Any]],
    metrics: dict[str, Any],
) -> dict[str, Any]:
    """Combine model-authored deliverables with engine-owned execution facts."""
    authored = copy.deepcopy(semantic) if isinstance(semantic, dict) else {}
    gaps = [g for row in subtasks for g in (row.get("gaps") or []) if isinstance(g, dict)]
    blocked = any(row.get("status") == "blocked" for row in subtasks)
    partial = any(row.get("status") != "completed" for row in subtasks)
    initial_status = "blocked" if blocked else "partial" if partial else "completed"
    result = {
        "contract_version": WORK_ORDER_CONTRACT,
        "work_order_id": str(envelope.get("work_order_id") or ""),
        "todo_id": envelope.get("todo_id"),
        "status": initial_status,
        "subtasks": copy.deepcopy(subtasks),
        "deliverables": authored.get("deliverables") if isinstance(authored.get("deliverables"), list) else [],
        "proposed_actions": _proposed_actions(authored),
        "actual_counts": _actual_counts(authored, metrics),
        "evidence_refs": sorted({
            str(ref) for row in subtasks for ref in (row.get("evidence_refs") or []) if str(ref).strip()
        }),
        "acceptance": [],
        "completion_requirements": [],
        "metrics": {
            "tool_calls_total": int(metrics.get("tool_calls_total") or 0),
            "records_created": int(metrics.get("records_created") or 0),
            "recall_hits": int(metrics.get("recall_hits") or 0),
            "web_calls": int(metrics.get("web_calls") or 0),
            "records_persisted": int(metrics.get("records_persisted") or 0),
            "source_backed_records": int(metrics.get("source_backed_records") or 0),
            "distinct_records": int(metrics.get("distinct_records") or 0),
        },
        "gaps": gaps,
        "needs_input": authored.get("needs_input") if isinstance(authored.get("needs_input"), list) else [],
        "blockers": authored.get("blockers") if isinstance(authored.get("blockers"), list) else [],
        "report_markdown": str(authored.get("report_markdown") or "").strip(),
        "checkpoint": _checkpoint(authored, initial_status),
    }
    criteria = [str(x).strip() for x in (envelope.get("acceptance_criteria") or []) if str(x).strip()]
    for requirement in (envelope.get("completion_requirements") or []):
        if not isinstance(requirement, dict):
            continue
        check_type = str(requirement.get("type") or "").strip()
        matching = [check for row in subtasks for check in (row.get("checks") or [])
                    if str(check.get("type") or "").strip() == check_type]
        result["completion_requirements"].append({
            "type": check_type,
            "met": bool(matching) and all(check.get("passed") is True for check in matching),
            "checks": copy.deepcopy(matching),
        })
    for criterion in criteria:
        matching = [check for row in subtasks for check in (row.get("checks") or [])
                    if str(check.get("criterion") or "").strip() == criterion]
        result["acceptance"].append({
            "criterion": criterion,
            "met": bool(matching) and all(check.get("passed") is True for check in matching),
            "evidence": [str(check.get("observed") or "") for check in matching if check.get("observed")],
        })
    if any(item.get("met") is not True for item in result["acceptance"]):
        result["status"] = "partial" if result["status"] != "blocked" else "blocked"
    if any(item.get("met") is not True for item in result["completion_requirements"]):
        result["status"] = "partial" if result["status"] != "blocked" else "blocked"
    if result["status"] == "completed":
        result["checkpoint"]["disposition"] = "complete"
    return result


def work_order_result_errors(result: Any) -> list[str]:
    if not isinstance(result, dict):
        return ["result must be an object"]
    errors: list[str] = []
    if result.get("contract_version") != WORK_ORDER_CONTRACT:
        errors.append("contract_version must be work-order-result.v2")
    subtasks = result.get("subtasks")
    if not isinstance(subtasks, list) or not subtasks:
        errors.append("at least one subtask is required")
        return errors
    for row in subtasks:
        checks = row.get("checks") if isinstance(row, dict) else None
        if not isinstance(checks, list) or not checks:
            errors.append(f"subtask {row.get('id') if isinstance(row, dict) else '?'} has no checks")
            continue
        if not any(str(c.get("type") or "") != "judgment" for c in checks if isinstance(c, dict)):
            errors.append(f"subtask {row.get('id')} has only judgment checks")
        if row.get("status") == "completed" and any(c.get("passed") is not True for c in checks if isinstance(c, dict)):
            errors.append(f"subtask {row.get('id')} completed with failed checks")
    if result.get("status") == "completed":
        if result.get("gaps"):
            errors.append("completed result cannot contain gaps")
        if result.get("blockers"):
            errors.append("completed result cannot contain blockers")
        if result.get("needs_input"):
            errors.append("completed result cannot require input")
        pending = [row for row in (result.get("deliverables") or [])
                   if isinstance(row, dict) and str(row.get("status") or "").lower()
                   in {"pending", "blocked", "missing", "partial"}]
        if pending:
            errors.append("completed result cannot contain pending deliverables")
        if any(item.get("met") is not True for item in (result.get("acceptance") or [])):
            errors.append("completed result has unmet acceptance criteria")
        requirements = result.get("completion_requirements") or []
        if any(item.get("met") is not True for item in requirements):
            errors.append("completed result has unmet completion requirements")
        for action in result.get("proposed_actions") or []:
            if not isinstance(action, dict) or not action.get("capability") or not action.get("operation"):
                errors.append("completed result contains an invalid proposed action")
            if action.get("authority_required") is not True:
                errors.append("Room proposed actions must retain the HQ authority boundary")
        if (result.get("checkpoint") or {}).get("disposition") != "complete":
            errors.append("completed result must close its execution checkpoint")
    return errors


def govern_work_order_result(result: dict[str, Any]) -> dict[str, Any]:
    errors = work_order_result_errors(result)
    if errors and result.get("status") == "completed":
        result["status"] = "partial"
    return {"accepted": not errors and result.get("status") == "completed", "errors": errors, "result": result}
