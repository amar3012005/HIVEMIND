"""Fine-grained, per-action-type standing approval rules (2026-08-14) — the
gap vs. xAI's Grok Bot reference: HIVEMIND had one coarse per-room "autoSend"
toggle for ALL outbound email; Grok Bot lets an org say "always allow: create
a Drive doc" while a different action type ("send an email") still asks.
_gate_write now checks an org-level rule FIRST, ahead of the ordinary turn
write policy. No rule for a label = existing ask/deny/authorized policy
applies exactly as before.
"""
from hivemind_employees.agents.agentscope_tools import (
    _gate_write,
    begin_turn_write_gate,
    drain_pending_writes,
    set_approval_rules,
)


def _attempt(label="gmail_send", *, force=False):
    return _gate_write(
        label, "Execute one exact action", "mcp",
        {"tool": "opaque_tool", "arguments": {"value": 1}}, force=force,
    )


def test_no_rules_configured_falls_through_to_ordinary_policy():
    set_approval_rules(None)
    begin_turn_write_gate("auto")
    response = _attempt(force=True)
    assert response is not None
    assert response.metadata["status"] == "pending_approval"


def test_always_deny_rule_blocks_even_under_auto_policy():
    set_approval_rules({"gmail_send": "always_deny"})
    begin_turn_write_gate("auto")
    response = _attempt("gmail_send")
    assert response is not None
    assert response.metadata["status"] == "write_denied"
    assert response.metadata["reason"] == "org_approval_rule"
    assert drain_pending_writes() == []


def test_always_allow_rule_bypasses_a_forced_outward_send():
    """gmail_send normally ALWAYS asks (force=True) regardless of room policy.
    An explicit, org-configured always_allow rule for this exact label is the
    one thing allowed to bypass that — never a default, always opt-in."""
    set_approval_rules({"gmail_send": "always_allow"})
    begin_turn_write_gate("auto")
    assert _attempt("gmail_send", force=True) is None
    assert drain_pending_writes() == []


def test_rule_is_scoped_to_its_exact_label_not_every_action():
    set_approval_rules({"docs_create": "always_allow"})
    begin_turn_write_gate("auto")
    # docs_create is allowed...
    assert _attempt("docs_create") is None
    # ...but gmail_send (a different label) still asks, same turn.
    response = _attempt("gmail_send", force=True)
    assert response is not None
    assert response.metadata["status"] == "pending_approval"


def test_always_deny_rule_still_wins_over_read_only_deny_policy():
    """Belt and suspenders: an explicit deny rule and the turn's own deny
    policy agree — denial is denial either way, no double-approval noise."""
    set_approval_rules({"gmail_send": "always_deny"})
    begin_turn_write_gate("deny")
    response = _attempt("gmail_send")
    assert response is not None
    assert response.metadata["status"] == "write_denied"
    assert response.metadata["reason"] == "org_approval_rule"
