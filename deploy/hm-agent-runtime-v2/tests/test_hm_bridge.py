import unittest
from unittest.mock import patch

from hm_bridge import EventForwarder, WorkRunBinding, build_execution_identity
import extra_agent_tools
from extra_agent_tools import RecordArtifactTool


class _Response:
    status_code = 200


class _Client:
    def __init__(self):
        self.posts = []

    async def post(self, url, **kwargs):
        self.posts.append((url, kwargs))
        return _Response()


class HmBridgeTests(unittest.IsolatedAsyncioTestCase):
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

    def test_identity_uses_turn_not_workrun(self):
        identity = build_execution_identity(binding=self.binding)
        self.assertEqual(identity["execution_id"], "turn-1")
        self.assertEqual(identity["turn_id"], "turn-1")
        self.assertNotEqual(identity["execution_id"], self.binding.workrun_id)

    async def test_forwarding_uses_only_durable_workrun_sink(self):
        client = _Client()
        forwarder = EventForwarder(
            binding=self.binding,
            master_key="test-key",
            base_url="http://hm-core.test",
        )
        await forwarder._forward(client, {"type": "REPLY_END", "finished_reason": "completed"})
        self.assertEqual(len(client.posts), 1)
        url, kwargs = client.posts[0]
        self.assertEqual(url, "http://hm-core.test/internal/workruns/workrun-1/event")
        self.assertNotIn("complete", kwargs["json"])
        self.assertEqual(forwarder.stats, {"forwarded": 1, "failed": 0})

    async def test_unrelated_custom_events_are_not_forwarded(self):
        client = _Client()
        forwarder = EventForwarder(binding=self.binding, master_key="test-key", base_url="http://hm-core.test")
        await forwarder._forward(client, {"type": "CUSTOM", "name": "workspace.started"})
        self.assertEqual(client.posts, [])

    async def test_state_updated_custom_event_is_forwarded_for_task_projection(self):
        client = _Client()
        forwarder = EventForwarder(binding=self.binding, master_key="test-key", base_url="http://hm-core.test")
        await forwarder._forward(client, {
            "type": "CUSTOM",
            "name": "state_updated",
            "value": {"tasks_context": {"tasks": []}},
        })
        self.assertEqual(len(client.posts), 1)
        self.assertEqual(client.posts[0][1]["json"]["event"]["name"], "state_updated")

    async def test_workrun_confirmation_is_resumed_internally_not_forwarded(self):
        client = _Client()
        resumed = []

        async def resume(event):
            resumed.append(event)

        forwarder = EventForwarder(
            binding=self.binding,
            master_key="test-key",
            base_url="http://hm-core.test",
            on_confirmation=resume,
        )
        event = {
            "type": "REQUIRE_USER_CONFIRM",
            "reply_id": "reply-1",
            "tool_calls": [{"id": "call-1", "name": "Bash"}],
        }
        await forwarder._forward(client, event)
        self.assertEqual(resumed, [event])
        self.assertEqual(client.posts, [])

    async def test_artifact_tool_forwards_server_minted_session_identity(self):
        captured = {}

        async def call_hm_core(path, **kwargs):
            captured["path"] = path
            captured.update(kwargs)
            return {"artifact_id": "artifact-1"}

        tool = RecordArtifactTool("user-1", "org-1", "agentscope-session-1")
        with patch.object(extra_agent_tools, "_WORKSPACE_MANAGER", None), patch("extra_agent_tools._call_hm_core", call_hm_core):
            await tool.call("deliverables/report.md", "Report")

        self.assertEqual(captured["path"], "/internal/hivemind/artifacts")
        self.assertEqual(captured["body"]["agentscope_session_id"], "agentscope-session-1")

    async def test_artifact_tool_durable_mode_sends_verified_bytes(self):
        captured = {}

        async def call_hm_core(path, **kwargs):
            captured.update(kwargs)
            return {"artifact_id": "artifact-durable"}

        class Backend:
            workdir = "/workspace"

            def abspath(self, value):
                return value

            def join_path(self, root, path):
                return f"{root}/{path}"

            async def file_exists(self, _path):
                return True

            async def read_file(self, _path):
                return b"artifact bytes"

        class Workspace:
            workdir = "/workspace"

            def get_backend(self):
                return Backend()

        class Manager:
            async def get_workspace(self, *_args):
                return Workspace()

        tool = RecordArtifactTool("user-1", "org-1", "session-1", "agent-1")
        with patch.object(extra_agent_tools, "_WORKSPACE_MANAGER", Manager()), patch.object(
            extra_agent_tools, "_ARTIFACT_DURABLE", True
        ), patch.object(extra_agent_tools, "_call_hm_core", call_hm_core):
            await tool.call("deliverables/report.md", "Report")

        self.assertEqual(captured["body"]["bytes_base64"], "YXJ0aWZhY3QgYnl0ZXM=")
        self.assertTrue(captured["body"]["require_durable"])

    async def test_artifact_tool_rejects_missing_workspace_file(self):
        class Backend:
            workdir = "/workspace"

            def abspath(self, value):
                return value

            def join_path(self, root, path):
                return f"{root}/{path}"

            async def file_exists(self, _path):
                return False

        class Workspace:
            workdir = "/workspace"

            def get_backend(self):
                return Backend()

        class Manager:
            async def get_workspace(self, *_args):
                return Workspace()

        tool = RecordArtifactTool("user-1", "org-1", "session-1", "agent-1")
        with patch.object(extra_agent_tools, "_WORKSPACE_MANAGER", Manager()), patch(
            "extra_agent_tools._call_hm_core",
        ) as call_core:
            result = await tool.call("deliverables/missing.md", "Missing")

        self.assertEqual(result.state.value, "error")
        self.assertIn("does not exist", result.content[0].text)
        call_core.assert_not_called()


if __name__ == "__main__":
    unittest.main()
