import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from agentscope.app.middleware import ToolOffloadMiddleware
from agentscope.message import TextBlock
from agentscope.tool import ToolResponse


class _Toolkit:
    async def get_tool(self, name):
        return SimpleNamespace(is_state_injected=False, is_external_tool=False)


class _BackgroundTasks:
    def __init__(self):
        self.tasks = []

    async def register_task(self, **kwargs):
        self.tasks.append(kwargs)
        return "background-task-1"


class NativeToolOffloadTests(unittest.IsolatedAsyncioTestCase):
    async def test_slow_tool_offloads_once_then_delivers_one_native_inbox_hint(self):
        background = _BackgroundTasks()
        middleware = ToolOffloadMiddleware(
            bg_manager=background,
            message_bus=SimpleNamespace(),
            user_id="user-1",
            agent_id="agent-1",
            timeout_secs=0.001,
        )
        agent = SimpleNamespace(
            name="agent-1",
            state=SimpleNamespace(session_id="session-1"),
            toolkit=_Toolkit(),
        )
        tool_call = SimpleNamespace(id="call-1", name="slow_tool")

        async def slow_handler(**_kwargs):
            await asyncio.sleep(0.02)
            yield ToolResponse(content=[TextBlock(text="completed output")])

        with patch(
            "agentscope.app.middleware._tool_offload_middleware.deliver_to_inbox",
            new=AsyncMock(),
        ) as deliver:
            items = [
                item async for item in middleware.on_acting(
                    agent,
                    {"tool_call": tool_call},
                    slow_handler,
                )
            ]
            await asyncio.sleep(0.05)

        self.assertEqual(len(background.tasks), 1)
        self.assertEqual(background.tasks[0]["session_id"], "session-1")
        self.assertEqual(background.tasks[0]["tool_name"], "slow_tool")
        self.assertEqual(len(items), 2)
        self.assertEqual(items[-1].id, "call-1")
        self.assertIn("running in background", items[-1].content[0].text)
        deliver.assert_awaited_once()
        delivered = deliver.await_args.kwargs
        self.assertEqual(delivered["user_id"], "user-1")
        self.assertEqual(delivered["session_id"], "session-1")
        self.assertEqual(delivered["agent_id"], "agent-1")
        self.assertIn("completed output", str(delivered["payload"]))


if __name__ == "__main__":
    unittest.main()
