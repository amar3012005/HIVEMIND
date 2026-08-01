from hivemind_employees.agents.agentscope_tools import (
    _gate_write,
    begin_turn_write_gate,
    drain_pending_writes,
)


def _attempt(*, force=False):
    return _gate_write(
        "opaque_action",
        "Execute one exact action",
        "mcp",
        {"tool": "opaque_tool", "arguments": {"value": 1}},
        force=force,
    )


def test_runtime_read_only_stage_denies_writes_without_queueing_approval():
    begin_turn_write_gate("deny")
    response = _attempt()
    assert response is not None
    assert response.metadata == {"status": "write_denied", "label": "opaque_action"}
    assert drain_pending_writes() == []


def test_exact_upstream_authority_avoids_a_second_generic_approval():
    begin_turn_write_gate("authorized")
    assert _attempt(force=True) is None
    assert drain_pending_writes() == []


def test_ordinary_room_policy_still_holds_forced_external_actions():
    begin_turn_write_gate("auto")
    response = _attempt(force=True)
    assert response is not None
    assert response.metadata["status"] == "pending_approval"
    assert len(drain_pending_writes()) == 1


def test_unknown_policy_fails_to_approval_instead_of_auto_execution():
    begin_turn_write_gate("unknown")
    response = _attempt()
    assert response is not None
    assert response.metadata["status"] == "pending_approval"
