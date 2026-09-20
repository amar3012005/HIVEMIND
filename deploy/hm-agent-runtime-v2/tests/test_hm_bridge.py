import unittest

from hm_bridge import EventForwarder, WorkRunBinding, build_execution_identity


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

    async def test_custom_events_are_not_forwarded(self):
        client = _Client()
        forwarder = EventForwarder(binding=self.binding, master_key="test-key", base_url="http://hm-core.test")
        await forwarder._forward(client, {"type": "CUSTOM"})
        self.assertEqual(client.posts, [])

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


if __name__ == "__main__":
    unittest.main()
