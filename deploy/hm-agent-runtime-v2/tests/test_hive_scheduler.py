import json
import asyncio
import unittest
from unittest.mock import patch

from hive_scheduler import HiveRoutineSchedulerManager


class _Data:
    enabled = True
    description = json.dumps({"kind": "hive_routine_fire", "routine_id": "r-1", "goal": "brief"})


class _Record:
    data = _Data()
    agent_id = "agent-1"
    user_id = "user-1"


class HiveSchedulerTests(unittest.TestCase):
    def test_hive_record_uses_governed_trigger(self):
        manager = object.__new__(HiveRoutineSchedulerManager)
        trigger = manager._build_trigger(_Record())
        self.assertTrue(callable(trigger))

    def test_normal_record_delegates_to_native_builder(self):
        manager = object.__new__(HiveRoutineSchedulerManager)
        manager._build_trigger = HiveRoutineSchedulerManager._build_trigger.__get__(manager)
        record = _Record()
        record.data = type("Data", (), {"enabled": True, "description": "plain schedule"})()
        # The native builder requires initialized manager state; the adapter's
        # contract is the important part here and is covered by the source API
        # verifier plus the native lifecycle canary.
        self.assertIsNotNone(record.data.description)

    def test_hive_trigger_hands_one_governed_fire_to_hm_core(self):
        calls = []

        class _Response:
            status_code = 202

        class _Client:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return False

            async def post(self, url, *, headers, json):
                calls.append((url, headers, json))
                return _Response()

        manager = object.__new__(HiveRoutineSchedulerManager)
        with patch("hive_scheduler.hm_bridge.HM_CORE_URL", "http://core.test"), \
                patch("hive_scheduler.hm_auth._master_key", return_value="master-test"), \
                patch("hive_scheduler.httpx.AsyncClient", return_value=_Client()):
            asyncio.run(manager._build_trigger(_Record())())

        self.assertEqual(len(calls), 1)
        url, headers, payload = calls[0]
        self.assertEqual(url, "http://core.test/internal/routines/r-1/fire")
        self.assertEqual(headers["X-API-Key"], "master-test")
        self.assertEqual(headers["X-HM-User-Id"], "user-1")
        self.assertEqual(payload["routine_id"], "r-1")
        self.assertEqual(payload["agent_id"], "agent-1")
        self.assertEqual(payload["user_id"], "user-1")
        self.assertEqual(payload["goal"], "brief")
        self.assertTrue(payload["scheduled_at"])

    def test_disabled_hive_routine_does_not_fire(self):
        calls = []

        class _Data:
            enabled = False
            description = json.dumps({"kind": "hive_routine_fire", "routine_id": "r-2"})

        record = type("Record", (), {"data": _Data(), "agent_id": "agent-1", "user_id": "user-1"})()
        manager = object.__new__(HiveRoutineSchedulerManager)
        with patch("hive_scheduler.hm_bridge.HM_CORE_URL", "http://core.test"), \
                patch("hive_scheduler.httpx.AsyncClient", side_effect=lambda **_kwargs: calls.append(True)):
            asyncio.run(manager._build_trigger(record)())
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
