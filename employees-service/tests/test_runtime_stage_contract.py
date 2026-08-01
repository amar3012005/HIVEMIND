import asyncio
import json

from hivemind_employees.hyper.engine import Director


def _director(envelope):
    async def emit(_event):
        return None

    return Director(
        user_message=envelope["objective"],
        user_id="user-1",
        org_id="org-1",
        project_id=None,
        participants=[{"slug": "lead", "name": "Lead", "_lane": "Strategist"}],
        room_template="auto",
        room_goal="Operate the assigned domain.",
        enabled_connectors=[],
        emit=emit,
        room_kind="general",
        execution_context=json.dumps(envelope),
    )


def test_runtime_stage_parser_is_separate_from_legacy_work_order():
    envelope = {
        "contract": "runtime-stage.v1",
        "run_id": "run-1",
        "stage_id": "capture",
        "objective": "Capture the request.",
        "expected_artifacts": ["request_record"],
    }
    director = _director(envelope)
    assert director.runtime_stage == envelope
    assert director.work_order is None


def test_runtime_stage_synthesis_filters_unknown_keys_and_unbacked_references(monkeypatch):
    envelope = {
        "contract": "runtime-stage.v1",
        "run_id": "run-1",
        "stage_id": "capture",
        "objective": "Capture the request.",
        "expected_artifacts": ["request_record"],
        "completion_checks": [{"predicate": "has_min_count", "select": "request_record", "value": 1}],
    }
    director = _director(envelope)
    director.blackboard = ["Observed request R-100 from the source system."]
    director.work_results = [{"output": {"text": "Captured R-100."}}]

    async def synth_call(*_args, **_kwargs):
        return {"content": json.dumps({
            "artifacts": [
                {"key": "request_record", "data": {"request_id": "R-100"},
                 "source_refs": ["board:1", "invented:9"]},
                {"id": "bad", "key": "unexpected_record", "data": {}, "source_refs": ["board:1"]},
            ],
            "gaps": [],
            "summary": "Captured the request.",
        })}

    monkeypatch.setattr(director, "_groq", synth_call)
    result = asyncio.run(director._synthesize_runtime_stage_result())
    assert result["contract"] == "runtime-stage-result.v1"
    assert result["run_id"] == "run-1"
    assert result["stage_id"] == "capture"
    assert len(result["artifacts"]) == 1
    assert result["artifacts"][0]["key"] == "request_record"
    assert result["artifacts"][0]["source_refs"] == ["board:1"]


def test_runtime_stage_never_claims_artifacts_without_room_evidence(monkeypatch):
    director = _director({
        "contract": "runtime-stage.v1",
        "run_id": "run-2",
        "stage_id": "capture",
        "objective": "Capture the request.",
        "expected_artifacts": ["request_record"],
    })

    async def synth_call(*_args, **_kwargs):
        return {"content": '{"artifacts":[{"key":"request_record","data":{"request_id":"invented"}}],"gaps":[]}' }

    monkeypatch.setattr(director, "_groq", synth_call)
    result = asyncio.run(director._synthesize_runtime_stage_result())
    assert result["artifacts"] == []
    assert result["gaps"]


def test_runtime_stage_retains_actual_tool_payload_for_artifact_compilation(monkeypatch):
    director = _director({
        "contract": "runtime-stage.v1",
        "run_id": "run-3",
        "stage_id": "discover",
        "objective": "Collect source-backed records.",
        "expected_artifacts": ["record"],
    })

    async def execute_tool(_name, _args):
        return '{"records":[{"id":"durable-1","source":"provider-1"}]}'

    monkeypatch.setattr(director, "_exec", execute_tool)
    asyncio.run(director._gather_one("sample_tool", {"query": "bounded"}))
    assert any("TOOL_RESULT[sample_tool]" in row and "durable-1" in row for row in director.blackboard)


def test_runtime_stage_exposes_prior_artifacts_as_citable_evidence(monkeypatch):
    envelope = {
        "contract": "runtime-stage.v1",
        "run_id": "run-4",
        "stage_id": "transform",
        "objective": "Transform every supplied record.",
        "inputs": {
            "artifacts.request_record": [
                {"id": "request-1", "key": "request_record", "data": {"name": "Alpha"}},
                {"id": "request-2", "key": "request_record", "data": {"name": "Beta"}},
            ]
        },
        "expected_artifacts": ["result_record"],
        "completion_checks": [{
            "predicate": "count_matches", "select": "result_record", "target_select": "request_record"
        }],
    }
    director = _director(envelope)
    captured = {}

    async def synth_call(messages, **_kwargs):
        captured["payload"] = json.loads(messages[1]["content"])
        return {"content": json.dumps({
            "artifacts": [
                {"key": "result_record", "data": {"name": "Alpha"},
                 "source_refs": ["input:artifacts.request_record:1"]},
                {"key": "result_record", "data": {"name": "Beta"},
                 "source_refs": ["input:artifacts.request_record:2"]},
            ],
            "gaps": [],
        })}

    monkeypatch.setattr(director, "_groq", synth_call)
    result = asyncio.run(director._synthesize_runtime_stage_result())
    evidence_ids = {row["id"] for row in captured["payload"]["evidence"]}
    assert "input:artifacts.request_record:1" in evidence_ids
    assert "input:artifacts.request_record:2" in evidence_ids
    assert "inputs" not in captured["payload"]["stage"]
    assert len(result["artifacts"]) == 2
