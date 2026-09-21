import unittest
from types import SimpleNamespace
from unittest.mock import ANY, AsyncMock, patch

from agentscope.app._manager import SchedulerManager
from agentscope.app.storage import ChatModelConfig, ScheduleData, ScheduleRecord
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class NativeSchedulerConfigTests(unittest.TestCase):
    def test_single_runtime_owns_agentscope_scheduler_and_channel_worker(self):
        app_source = (ROOT / "app.py").read_text(encoding="utf-8")
        compose = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")

        self.assertIn("enable_scheduler=ENABLE_SCHEDULER", app_source)
        self.assertIn("enable_channel_worker=ENABLE_CHANNEL_WORKER", app_source)
        self.assertIn('AGENTSCOPE_ENABLE_SCHEDULER: "1"', compose)
        self.assertIn('AGENTSCOPE_ENABLE_CHANNEL_WORKER: "1"', compose)
        self.assertIn("Exactly one replica may hold these", app_source)


class NativeSchedulerFireTests(unittest.IsolatedAsyncioTestCase):
    async def test_native_schedule_fire_creates_a_fresh_session_and_wakes_it(self):
        """A routine is an AgentScope schedule, not a second HIVE cron runner."""
        storage = SimpleNamespace(
            upsert_session=AsyncMock(return_value=SimpleNamespace(id="scheduled-session-1")),
        )
        workspace = SimpleNamespace(assign_workspace_id=AsyncMock(return_value="workspace-1"))
        manager = SchedulerManager(storage, SimpleNamespace(), workspace, enabled=False)
        record = ScheduleRecord(
            id="schedule-1",
            user_id="user-1",
            agent_id="agent-1",
            data=ScheduleData(
                name="Daily operating brief",
                description="Summarize the latest company operating state.",
                cron_expression="0 9 * * 1-5",
                chat_model_config=ChatModelConfig(
                    type="openai_chat",
                    credential_id="credential-1",
                    model="gateway/deepseek",
                    parameters={},
                ),
                stateful=False,
            ),
        )
        with patch("agentscope.app._manager._scheduler._scheduler_manager.deliver_to_inbox", new=AsyncMock()) as deliver:
            await manager._build_trigger(record)()

        workspace.assign_workspace_id.assert_awaited_once_with(
            user_id="user-1", agent_id="agent-1", session_id=ANY,
        )
        storage.upsert_session.assert_awaited_once()
        session_kwargs = storage.upsert_session.await_args.kwargs
        self.assertEqual(session_kwargs["user_id"], "user-1")
        self.assertEqual(session_kwargs["agent_id"], "agent-1")
        deliver.assert_awaited_once()
        delivered = deliver.await_args.kwargs
        self.assertEqual(delivered["user_id"], "user-1")
        self.assertEqual(delivered["agent_id"], "agent-1")
        self.assertEqual(delivered["session_id"], "scheduled-session-1")
        self.assertIn("<scheduled-task>", delivered["payload"]["hint"])


if __name__ == "__main__":
    unittest.main()
