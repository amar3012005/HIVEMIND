import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

import app
from hm_bridge import WorkRunBinding


class _Store:
    def __init__(self, binding):
        self.binding = binding

    async def get(self, workrun_id):
        return self.binding if self.binding and self.binding.workrun_id == workrun_id else None


class WorkRunCancelTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.binding = WorkRunBinding(
            workrun_id="workrun-1",
            user_id="user-1",
            org_id="org-1",
            agent_id="agent-1",
            session_id="session-1",
            turn_id="turn-1",
            room_id="room-1",
        )

    async def test_stop_cancels_only_the_active_agentscope_session_for_its_owner(self):
        sessions = SimpleNamespace(cancel_session_run=AsyncMock(return_value=True))
        with patch.object(app, "_workrun_store", _Store(self.binding)), patch.object(
            app.app.state, "session_service", sessions, create=True,
        ):
            result = await app.cancel_workrun("workrun-1", user_id="user-1")

        sessions.cancel_session_run.assert_awaited_once_with("session-1")
        self.assertEqual(result, {
            "workrun_id": "workrun-1",
            "session_id": "session-1",
            "cancelled": True,
            "lock_released": True,
        })

    async def test_stop_refuses_a_workrun_owned_by_another_user(self):
        sessions = SimpleNamespace(cancel_session_run=AsyncMock(return_value=True))
        with patch.object(app, "_workrun_store", _Store(self.binding)), patch.object(
            app.app.state, "session_service", sessions, create=True,
        ):
            with self.assertRaises(HTTPException) as raised:
                await app.cancel_workrun("workrun-1", user_id="another-user")

        self.assertEqual(raised.exception.status_code, 404)
        sessions.cancel_session_run.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
