import pytest

from hivemind_employees.hyper.engine import Director, _visual_artifacts_enabled


def test_visual_path_is_default_off_and_accepts_exact_flag(monkeypatch):
    monkeypatch.delenv("Visual_path_In_Hyperrooms", raising=False)
    monkeypatch.delenv("VISUAL_PATH_IN_HYPERROOMS", raising=False)
    assert _visual_artifacts_enabled() is False
    monkeypatch.setenv("Visual_path_In_Hyperrooms", "True")
    assert _visual_artifacts_enabled() is True


@pytest.mark.asyncio
async def test_visual_producer_repairs_once_and_returns_verified_receipt():
    director = object.__new__(Director)
    calls = []

    async def direction(_forced, _transcript):
        return {"visual_thesis": "A decision story"}

    async def synth(_forced, _transcript, _direction, repair_errors=None, prior_html="", prior_spec=None):
        calls.append({"direction": _direction, "errors": repair_errors, "prior": prior_html, "spec": prior_spec})
        return {"html": "<!doctype html><h1>Board</h1>", "summary": "Ready"}

    deliveries = iter([
        {"artifact": {"ok": False, "errors": ["Mobile has horizontal overflow."]}},
        {"artifact": {"ok": True, "artifact_id": "artifact-1"}},
    ])

    async def emit(event):
        assert event["t"] == "artifact_candidate"
        return next(deliveries)

    director._synthesize_visual = synth
    director._plan_visual_direction = direction
    director.emit = emit
    result = await director._produce_visual_artifact(False, "")

    assert result["receipt"]["artifact_id"] == "artifact-1"
    assert len(calls) == 2
    assert calls[1]["errors"] == ["Mobile has horizontal overflow."]
    assert calls[1]["prior"].startswith("<!doctype html>")


@pytest.mark.asyncio
async def test_artifact_only_profile_stops_before_expensive_work_when_renderer_is_disabled(monkeypatch):
    monkeypatch.delenv("Visual_path_In_Hyperrooms", raising=False)
    monkeypatch.delenv("VISUAL_PATH_IN_HYPERROOMS", raising=False)
    director = object.__new__(Director)
    director.participants = [{"slug": "lead"}]
    director.execution_profile = {
        "profile_id": "fundraising.artifact.v1",
        "allowed_outputs": ["artifact"],
        "required_artifacts": ["fundraising_artifact"],
    }
    director.transcript = []
    director.io = {"input": 0, "output": 0}
    director.tok_by = {}
    events = []

    async def emit(event):
        events.append(event)

    director.emit = emit
    result = await director.run()

    assert result["cost_tokens"] == 0
    assert result["artifact_path_error"] == "visual_artifact_path_disabled"
    assert result["intended_output"] == "artifact"
    assert any(event.get("code") == "visual_artifact_path_disabled" for event in events)
