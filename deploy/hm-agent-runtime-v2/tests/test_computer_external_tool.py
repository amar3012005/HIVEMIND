import asyncio
import json

from extra_agent_tools import ComputerRunTask
from computer_executor import ComputerExecutorError, ComputerPoolExecutor


def test_external_tool_schema_is_bounded():
    assert ComputerRunTask.is_external_tool is True
    assert ComputerRunTask.is_concurrency_safe is False
    assert set(ComputerRunTask.input_schema["properties"]) >= {
        "objective", "allowed_domains", "capabilities", "max_steps", "timeout_seconds",
    }


def test_unconfigured_executor_fails_closed():
    async def run():
        try:
            await ComputerPoolExecutor().run(
                user_id="u", org_id="o", agent_run_id="s", objective="read",
                allowed_domains=["example.com"], capabilities=["read"],
            )
        except ComputerExecutorError as exc:
            assert "not configured" in str(exc)
            return
        raise AssertionError("unconfigured executor did not fail closed")

    asyncio.run(run())
