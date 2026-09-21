"""Regression coverage for native AgentScope plan projection.

The browser is deliberately not the task ledger.  These tests prove that the
existing Room callback receives a bounded projection of the PlanNotebook's
state as it changes, which lets the existing streamed-event persistence own
replay and ordering.
"""
import asyncio

import hivemind_employees.api_hyper_rooms as api


class _Subtask:
    def __init__(self, name, state):
        self.name = name
        self.description = "A bounded step"
        self.expected_outcome = "A verifiable result"
        self.state = state


class _Plan:
    name = "Launch plan"
    description = "Deliver the requested operating result"
    expected_outcome = "A completed result"
    subtasks = [_Subtask("Collect context", "done"), _Subtask("Execute", "in_progress")]


class _Reply:
    content = "Completed after the native plan."


def test_agentic_plan_change_is_projected_to_the_room_stream(monkeypatch):
    emitted = []

    async def fake_rules(_org_id):
        return {}

    async def fake_emit(callback_url, turn_id, event):
        emitted.append((callback_url, turn_id, event))

    async def fake_build(*_args, on_plan_change, **_kwargs):
        await on_plan_change(_Plan())

        async def agent(_message):
            return _Reply()

        return agent

    monkeypatch.setattr(api, "get_org_approval_rules", fake_rules)
    monkeypatch.setattr(api, "_emit_event", fake_emit)
    monkeypatch.setattr(api, "_build_lead_task_agent", fake_build)

    result = asyncio.run(api._run_agentic_task_agent(
        "room-1", {"slug": "lead"}, [], "user-1", "org-1", None,
        "turn-1", "Create an operating plan", "COMPANY CONTEXT", callback_url="http://core/callback",
    ))

    assert result == "Completed after the native plan."
    assert emitted == [(
        "http://core/callback", "turn-1", {
            "t": "task_plan",
            "source": "agentscope_plan_notebook",
            "name": "Launch plan",
            "description": "Deliver the requested operating result",
            "expected_outcome": "A completed result",
            "subtasks": [
                {
                    "id": "0", "title": "Collect context", "description": "A bounded step",
                    "expected_outcome": "A verifiable result", "status": "done",
                },
                {
                    "id": "1", "title": "Execute", "description": "A bounded step",
                    "expected_outcome": "A verifiable result", "status": "in_progress",
                },
            ],
        },
    )]
