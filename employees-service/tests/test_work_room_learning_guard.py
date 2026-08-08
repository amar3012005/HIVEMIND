import inspect

from hivemind_employees import api_hyper_rooms


def test_single_engine_loads_lessons_before_status_exists_and_reflects_only_after_completion():
    source = inspect.getsource(api_hyper_rooms._orchestrate_single_agent)

    preload = source.index("_evo_playbooks: Dict[str, list] = {}")
    final_report = source.index("_build_final_report(")
    completion_guard = source.index('if status == "complete" and _evo_mode')

    assert "if _evo_mode in" in source[preload:final_report]
    assert 'status == "complete"' not in source[preload:final_report]
    assert completion_guard > final_report
