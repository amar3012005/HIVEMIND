import inspect

from hivemind_employees import api_hyper_rooms
from hivemind_employees.hyper.engine import _normalize_work_step_handoff


def test_single_engine_loads_lessons_before_status_exists_and_reflects_only_after_completion():
    source = inspect.getsource(api_hyper_rooms._orchestrate_single_agent)

    preload = source.index("_evo_playbooks: Dict[str, list] = {}")
    final_report = source.index("_build_final_report(")
    completion_guard = source.index('if status == "complete" and _evo_mode')

    assert "if _evo_mode in" in source[preload:final_report]
    assert 'status == "complete"' not in source[preload:final_report]
    assert completion_guard > final_report


def test_runtime_handoff_owner_is_normalized_for_the_control_plane():
    assert _normalize_work_step_handoff({
        "owner": "HQ Runtime",
        "objective": "Schedule implementation planning",
        "rationale": "The verified work result is ready for HQ review.",
    })["owner"] == "runtime"


def test_work_room_verification_uses_the_active_human_message():
    source = inspect.getsource(api_hyper_rooms._orchestrate_single_agent)
    assert 'done_txt = req.user_message if (req.room_mode or "").strip().lower() == "work"' in source
