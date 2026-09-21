import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

import app
from hm_bridge import WorkRunBinding


class _Store:
    def __init__(self, binding=None):
        self.binding = binding
        self.puts = []

    async def get(self, workrun_id):
        if self.binding and self.binding.workrun_id == workrun_id:
            return self.binding
        return None

    async def put(self, binding):
        self.puts.append(binding)
        self.binding = binding


class WorkRunRecoveryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.body = {
            "workrun_id": "workrun-1",
            "agent_id": "agent-1",
            "session_id": "session-1",
            "turn_id": "turn-1",
            "room_id": "room-1",
            "org_id": "org-1",
            "workspace_id": "workrun:workrun-1",
        }

    async def test_recovery_rebinds_a_persisted_session_without_replaying_the_goal(self):
        store = _Store()
        storage = SimpleNamespace(get_session=AsyncMock(return_value=SimpleNamespace(
            config=SimpleNamespace(workspace_id="workrun:workrun-1"),
        )))
        forwarder = AsyncMock(return_value=True)
        dispatch = AsyncMock()
        with patch.object(app, "_workrun_store", store), patch.object(
            app.app.state, "storage", storage, create=True,
        ), patch.object(app, "_ensure_workrun_forwarder", forwarder), patch.object(
            app, "_dispatch_chat", dispatch,
        ):
            result = await app.recover_workrun_session(self.body, user_id="user-1")

        self.assertEqual(result, {
            "workrun_id": "workrun-1", "session_id": "session-1",
            "workspace_id": "workrun:workrun-1", "recovered": True,
        })
        self.assertEqual(len(store.puts), 1)
        self.assertEqual(store.puts[0].turn_id, "turn-1")
        forwarder.assert_awaited_once_with(store.binding)
        dispatch.assert_not_awaited()

    async def test_recovery_rejects_a_binding_that_changes_the_durable_identity(self):
        existing = WorkRunBinding(
            workrun_id="workrun-1", user_id="user-1", org_id="org-1",
            agent_id="another-agent", session_id="session-1", turn_id="turn-1", room_id="room-1",
        )
        store = _Store(existing)
        storage = SimpleNamespace(get_session=AsyncMock(return_value=SimpleNamespace(
            config=SimpleNamespace(workspace_id="workrun:workrun-1"),
        )))
        forwarder = AsyncMock()
        with patch.object(app, "_workrun_store", store), patch.object(
            app.app.state, "storage", storage, create=True,
        ), patch.object(app, "_ensure_workrun_forwarder", forwarder):
            with self.assertRaises(HTTPException) as raised:
                await app.recover_workrun_session(self.body, user_id="user-1")

        self.assertEqual(raised.exception.status_code, 409)
        forwarder.assert_not_awaited()

    async def test_recovery_fails_closed_when_the_persisted_agentscope_session_is_gone(self):
        store = _Store()
        storage = SimpleNamespace(get_session=AsyncMock(return_value=None))
        forwarder = AsyncMock()
        with patch.object(app, "_workrun_store", store), patch.object(
            app.app.state, "storage", storage, create=True,
        ), patch.object(app, "_ensure_workrun_forwarder", forwarder):
            with self.assertRaises(HTTPException) as raised:
                await app.recover_workrun_session(self.body, user_id="user-1")

        self.assertEqual(raised.exception.status_code, 404)
        self.assertEqual(store.puts, [])
        forwarder.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
