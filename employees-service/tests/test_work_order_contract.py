from hivemind_employees.hyper.work_order_contract import (
    assemble_work_order_result,
    work_order_result_errors,
)
from hivemind_employees.hyper.engine import Director


def _subtask(*, passed=True, check_type="tool_used"):
    return {
        "id": "subtask_1", "status": "completed" if passed else "partial",
        "checks": [{"criterion": "Return evidence", "type": check_type,
                    "observed": "tool_calls=1", "passed": passed}],
        "evidence_refs": ["source: company memory"], "gaps": [] if passed else [{"why": "tool missing"}],
    }


def _envelope():
    return {
        "work_order_id": "wo",
        "acceptance_criteria": ["Return evidence"],
        "completion_requirements": [{"type": "tool_used", "minimum": 1}],
    }


def test_engine_metrics_override_model_metrics():
    result = assemble_work_order_result(
        {"metrics": {"tool_calls_total": 99}, "report_markdown": "Done"},
        envelope=_envelope(),
        subtasks=[_subtask()], metrics={"tool_calls_total": 1, "records_created": 0},
    )
    assert result["metrics"]["tool_calls_total"] == 1
    assert result["status"] == "completed"


def test_judgment_only_subtask_is_rejected():
    result = assemble_work_order_result(
        {"report_markdown": "Looks done"},
        envelope=_envelope(),
        subtasks=[_subtask(check_type="judgment")], metrics={"tool_calls_total": 0},
    )
    assert any("only judgment" in error for error in work_order_result_errors(result))


def test_failed_check_never_rolls_up_to_completed():
    result = assemble_work_order_result(
        {"report_markdown": "Done"},
        envelope=_envelope(),
        subtasks=[_subtask(passed=False)], metrics={"tool_calls_total": 0},
    )
    assert result["status"] == "partial"
    assert result["checkpoint"]["disposition"] == "request_hq"


def test_room_authored_checkpoint_is_retained_for_hq_resume():
    result = assemble_work_order_result(
        {
            "report_markdown": "Discovery completed; qualification continues.",
            "deliverables": [{"kind": "prospect_records", "record_count": 3}],
            "checkpoint": {
                "stage": "discovery", "completed": ["source-backed discovery"],
                "next": "qualify and persist", "disposition": "continue_room",
                "reason": "The same Room can continue from retained records.", "requires": [],
            },
        },
        envelope=_envelope(), subtasks=[_subtask(passed=False)], metrics={"tool_calls_total": 1},
    )
    assert result["status"] == "partial"
    assert result["checkpoint"]["stage"] == "discovery"
    assert result["checkpoint"]["disposition"] == "continue_room"


def test_completed_result_always_closes_checkpoint():
    result = assemble_work_order_result(
        {"report_markdown": "Done", "checkpoint": {"disposition": "continue_room"}},
        envelope=_envelope(), subtasks=[_subtask()], metrics={"tool_calls_total": 1},
    )
    assert result["status"] == "completed"
    assert result["checkpoint"]["disposition"] == "complete"


def test_tool_error_payload_is_not_a_successful_call():
    assert Director._tool_result_succeeded('{"error":"upstream 400","is_error":true}') is False
    assert Director._tool_result_succeeded('{"found":2}') is True
    assert Director._tool_result_succeeded('source-backed web result') is True


def test_completed_result_with_blockers_or_pending_deliverables_is_rejected():
    result = assemble_work_order_result(
        {
            "report_markdown": "The requested records are still missing.",
            "blockers": [{"description": "No qualified records"}],
            "needs_input": [{"item": "Prospect evidence"}],
            "deliverables": [{"name": "Lead list", "status": "pending"}],
        },
        envelope=_envelope(),
        subtasks=[_subtask()], metrics={"tool_calls_total": 1},
    )
    errors = work_order_result_errors(result)
    assert "completed result cannot contain blockers" in errors
    assert "completed result cannot require input" in errors
    assert "completed result cannot contain pending deliverables" in errors
