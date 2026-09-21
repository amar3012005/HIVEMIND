"""Ephemeral AgentScope lifecycle acceptance checks.

This validates the native mechanisms HIVE relies on for scheduled and slow
work.  It deliberately uses an isolated Redis instance supplied by the shell
wrapper, so it never writes a shared runtime's session, inbox, or wakeup data.
"""

from __future__ import annotations

import asyncio
import os
from types import SimpleNamespace

from agentscope.app._manager import BackgroundTaskManager, SchedulerManager
from agentscope.app.message_bus import MessageBusKeys, RedisMessageBus
from agentscope.app.middleware import ToolOffloadMiddleware
from agentscope.app.storage import ChatModelConfig, RedisStorage, ScheduleData, ScheduleRecord
from agentscope.app.workspace_manager import IsolationPolicy, LocalWorkspaceManager
from agentscope.message import TextBlock
from agentscope.tool import ToolResponse


REDIS_HOST = os.environ["CANARY_REDIS_HOST"]
REDIS_PORT = int(os.getenv("CANARY_REDIS_PORT", "6379"))


class _Toolkit:
    async def get_tool(self, _name: str):
        return SimpleNamespace(is_state_injected=False, is_external_tool=False)


async def _prove_schedule(storage: RedisStorage, bus: RedisMessageBus) -> None:
    """Prove schedule fire persists a session, inbox hint, and one wakeup."""
    workspace = LocalWorkspaceManager("/tmp/lifecycle-canary", isolation=IsolationPolicy.PER_SESSION)
    manager = SchedulerManager(storage, bus, workspace, enabled=False)
    record = ScheduleRecord(
        id="schedule-canary",
        user_id="user-canary",
        agent_id="agent-canary",
        data=ScheduleData(
            name="Daily operating brief",
            description="Create the daily operating brief.",
            cron_expression="0 9 * * 1-5",
            chat_model_config=ChatModelConfig(
                type="openai_chat",
                credential_id="credential-canary",
                model="gateway/test",
                parameters={},
            ),
            stateful=False,
        ),
    )

    await manager._build_trigger(record)()
    sessions = await storage.list_sessions_by_schedule("user-canary", "schedule-canary")
    assert len(sessions) == 1, sessions
    inbox = await bus.queue_drain(MessageBusKeys.inbox(sessions[0].id))
    wakeups = await bus.queue_drain(MessageBusKeys.wakeup_queue())
    assert len(inbox) == 1 and "scheduled-task" in inbox[0][1]["hint"], inbox
    assert len(wakeups) == 1 and wakeups[0][1]["session_id"] == sessions[0].id, wakeups
    print("scheduler-durable-canary-ok", sessions[0].id, "inbox=1", "wakeups=1")


async def _prove_offload(bus: RedisMessageBus) -> None:
    """Prove one timed-out tool result returns through the native inbox."""
    middleware = ToolOffloadMiddleware(
        bg_manager=BackgroundTaskManager(bus),
        message_bus=bus,
        user_id="user-canary",
        agent_id="agent-canary",
        timeout_secs=0.001,
    )
    agent = SimpleNamespace(
        name="agent-canary",
        state=SimpleNamespace(session_id="offload-session-canary"),
        toolkit=_Toolkit(),
    )
    tool_call = SimpleNamespace(id="tool-call-canary", name="slow_tool")

    async def slow_handler(**_kwargs):
        await asyncio.sleep(0.02)
        yield ToolResponse(content=[TextBlock(text="durable offload result")])

    response = [item async for item in middleware.on_acting(agent, {"tool_call": tool_call}, slow_handler)]
    assert len(response) == 2 and "running in background" in response[-1].content[0].text
    for _ in range(20):
        inbox = await bus.queue_drain(MessageBusKeys.inbox("offload-session-canary"))
        if inbox:
            break
        await asyncio.sleep(0.02)
    wakeups = await bus.queue_drain(MessageBusKeys.wakeup_queue())
    assert len(inbox) == 1 and "durable offload result" in str(inbox[0][1]), inbox
    assert len(wakeups) == 1 and wakeups[0][1]["session_id"] == "offload-session-canary", wakeups
    print("offload-durable-canary-ok", "response=background", "inbox=1", "wakeups=1")


async def main() -> None:
    storage = RedisStorage(host=REDIS_HOST, port=REDIS_PORT)
    bus = RedisMessageBus(host=REDIS_HOST, port=REDIS_PORT)
    async with storage, bus:
        await _prove_schedule(storage, bus)
        await _prove_offload(bus)


if __name__ == "__main__":
    asyncio.run(main())
