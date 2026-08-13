"""HQ contract bridge (2026-08-14): work-dispatcher.js posts an HQ routine's
work order to the SAME /internal/hyper/room-turn route every turn uses, so
execution_engine=="agentic" can fire for HQ-dispatched work exactly like any
user turn. But core's roomVerdict() only accepts a work-order-result.v2
contract (normally built from self.work_results by
_synthesize_work_order_result) — the agentic engine had no equivalent, so an
HQ work order routed there would be marked "blocked" regardless of how good
the actual work was. This bridges the agentic engine's output into that
contract, deliberately conservative: never claims "completed" (no
deterministic per-check verification exists yet for this engine), so HQ
routes it for review instead of either falsely trusting or falsely
discarding real work.
"""
import asyncio

from hivemind_employees.hyper.engine import Director


def _director(*, agentic_task_hook, work_order=None):
    async def emit(event):
        pass

    d = Director(
        user_message="run the weekly outreach digest", user_id="user-1", org_id="org-1",
        project_id=None, participants=[{"slug": "lead", "name": "Lead", "_lane": "Strategist"}],
        room_template="auto", room_goal="", enabled_connectors=[], emit=emit,
        room_kind="outreach", intended_output="answer", agentic_task_hook=agentic_task_hook,
    )
    d.work_order = work_order
    return d


def test_no_work_order_produces_no_contract():
    """A normal, non-HQ turn must be completely unaffected — no contract noise."""
    async def fake_hook(user_message, board_context):
        return "A normal answer, no HQ envelope involved."

    director = _director(agentic_task_hook=fake_hook, work_order=None)
    result = asyncio.run(director._run_agentic_task({}, 0.0))
    assert result["work_order_result"] is None


def test_hq_work_order_gets_a_conservative_contract():
    async def fake_hook(user_message, board_context):
        return "Found 3 real prospects and drafted outreach notes for each."

    envelope = {
        "work_order_id": "wo-123", "objective": "weekly outreach digest",
        "acceptance_criteria": [], "completion_requirements": [],
    }
    director = _director(agentic_task_hook=fake_hook, work_order=envelope)
    result = asyncio.run(director._run_agentic_task({}, 0.0))

    contract = result["work_order_result"]
    assert contract is not None
    assert contract["contract_version"] == "work-order-result.v2"
    assert contract["work_order_id"] == "wo-123"
    # Never "completed" — no deterministic per-check verification exists for
    # this engine yet. Real work is preserved in report_markdown either way.
    assert contract["status"] != "completed"
    assert "3 real prospects" in contract["report_markdown"]
    # Conservative default when no deliverables were declared: request_hq,
    # not a silent auto-continue or a false "complete".
    assert contract["checkpoint"]["disposition"] == "request_hq"


def test_hq_bridge_survives_a_broken_envelope():
    """A malformed work_order envelope must never crash the turn — same
    'can only ADD behavior, never break a turn' contract as the rest of the
    agentic engine."""
    async def fake_hook(user_message, board_context):
        return "Real work happened despite a weird envelope."

    director = _director(agentic_task_hook=fake_hook, work_order={"objective": None})
    result = asyncio.run(director._run_agentic_task({}, 0.0))
    assert result is not None
    assert result["final_text"] == "Real work happened despite a weird envelope."
